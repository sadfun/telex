import { join } from "node:path";
import { type RunnerHandle, run } from "@grammyjs/runner";
import { type Api, Bot } from "grammy";
import type { BotCommand, CallbackQuery, Chat, Message, Update } from "grammy/types";
import type {
  ChoiceOption,
  DeliveryReceipt,
  InboundAttachment,
  InboundMessage,
  MessageHandler,
  MessageResponder,
  MessagingChannel,
  OutboundMessage,
  ProviderReference,
} from "../../core/channel.js";
import { type Deferred, deferred } from "../../shared/async.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { downloadTelegramFile, TelegramFileDownloadError } from "./file.js";
import {
  isTelegramTopicLifecycleMessage,
  normalizeTelegramMessage,
  type TelegramFileReference,
} from "./message.js";
import {
  parseTelegramDeliveryTarget,
  telegramDeliveryTarget,
  telegramMessageReference,
} from "./references.js";
import {
  type ChoiceRequester,
  decodeCommandCallback,
  publishTelegramMessage,
  TelegramGuestResponder,
  TelegramResponder,
  telegramSendParameters,
} from "./reply.js";
import { matchTelegramCommand, routeTelegramMessage, type TelegramReplyRoute } from "./route.js";

type PendingChoiceMessage =
  | { readonly kind: "normal"; readonly messageId: number }
  | {
      readonly kind: "ephemeral";
      readonly receiverUserId: number;
      readonly ephemeralMessageId: number;
    };

interface PendingChoice {
  readonly userId: number;
  readonly options: readonly ChoiceOption[];
  readonly result: Deferred<string>;
  readonly timer: NodeJS.Timeout;
  readonly chatId: number;
  readonly message: PendingChoiceMessage;
}

interface GuestUpdateWithReferences extends Update {
  readonly reference_messages?: readonly Message[];
}

interface GuestMessageWithReferences extends Message {
  readonly reference_messages?: readonly Message[];
}

export const telegramBotCommands = [
  { command: "start", description: "Set up Telex" },
  { command: "new", description: "Start a new Codex task" },
  { command: "back", description: "Return to the previous Codex task" },
  { command: "stop", description: "Stop the running turn" },
  { command: "schedules", description: "List scheduled runs" },
  { command: "status", description: "Show Codex status" },
  { command: "login", description: "Sign in to Codex" },
  { command: "logout", description: "Sign out of Codex" },
  { command: "config", description: "Open Codex settings" },
  { command: "reload", description: "Reload Codex resources" },
  { command: "restart", description: "Restart the Codex app-server" },
  { command: "update", description: "Update Telex" },
  { command: "help", description: "Show commands" },
] as const satisfies readonly BotCommand[];

export class TelegramChannel implements MessagingChannel {
  public readonly name = "telegram";
  readonly #bot: Bot;
  readonly #allowedUserIds: ReadonlySet<number>;
  readonly #pollTimeout: number;
  readonly #apiRoot: string;
  readonly #token: string;
  readonly #attachmentDirectory: string;
  readonly #logger: Logger;
  readonly #pendingChoices = new Map<string, PendingChoice>();
  #handler: MessageHandler | undefined;
  #runner: RunnerHandle | undefined;
  #botUsername: string | undefined;

  public constructor(
    token: string,
    apiRoot: string,
    allowedUserIds: ReadonlySet<number>,
    pollTimeout: number,
    attachmentDirectory: string,
    logger: Logger,
  ) {
    this.#token = token;
    this.#apiRoot = apiRoot;
    this.#allowedUserIds = allowedUserIds;
    this.#pollTimeout = pollTimeout;
    this.#attachmentDirectory = attachmentDirectory;
    this.#logger = logger;
    this.#bot = new Bot(token, { client: { apiRoot } });
    this.#bot.on("message", async (context) => {
      await this.handleMessage(context.message, false, context.api);
    });
    this.#bot.on("guest_message", async (context) => {
      const update = context.update as GuestUpdateWithReferences;
      const guestMessage = context.guestMessage as GuestMessageWithReferences;
      await this.handleMessage(
        guestMessage,
        true,
        context.api,
        update.reference_messages ?? guestMessage.reference_messages,
      );
    });
    this.#bot.on("callback_query:data", async (context) => {
      await this.handleCallback(context.callbackQuery, context.api);
    });
    this.#bot.catch((error) => {
      this.#logger.error("Telegram middleware failed", error.error, {
        updateId: error.ctx.update.update_id,
      });
    });
  }

  public async start(handler: MessageHandler): Promise<void> {
    this.#handler = handler;
    await this.#bot.init();
    const bot = this.#bot.botInfo;
    this.#botUsername = bot.username;
    this.#logger.info("Telegram bot connected through grammY", {
      username: bot.username,
      guestMode: bot.supports_guest_queries ?? false,
    });
    await this.#bot.api.setMyCommands(telegramBotCommands).catch((error: unknown) => {
      this.#logger.warn("Could not register Telegram commands", { error: errorMessage(error) });
    });

    this.#runner = run(this.#bot, {
      runner: {
        fetch: {
          timeout: this.#pollTimeout,
          allowed_updates: ["message", "guest_message", "callback_query"],
        },
        retryInterval: "exponential",
        silent: true,
      },
    });
  }

  public isAuthorized(principal: ProviderReference): boolean {
    if (principal.provider !== this.name || principal.resource !== "user") return false;
    if (!/^\d+$/u.test(principal.id)) return false;
    const userId = Number(principal.id);
    return Number.isSafeInteger(userId) && this.#allowedUserIds.has(userId);
  }

  public async stop(): Promise<void> {
    await this.#runner?.stop();
    for (const choice of this.#pendingChoices.values()) {
      clearTimeout(choice.timer);
      choice.result.resolve("decline");
    }
    this.#pendingChoices.clear();
  }

  public async publish(
    targetReference: ProviderReference,
    message: OutboundMessage,
  ): Promise<DeliveryReceipt> {
    const target = parseTelegramDeliveryTarget(targetReference);
    const route: TelegramReplyRoute = {
      destination: target.destination,
      visibility: { kind: "normal" },
    };
    const messageIds = await publishTelegramMessage(
      this.#bot.api,
      target.chatId,
      route,
      message,
      this.#logger,
    );
    return {
      publishedMessages: messageIds.map((messageId) =>
        telegramMessageReference(target.chatId, messageId),
      ),
    };
  }

  private async handleMessage(
    message: Message,
    guest: boolean,
    api: Api,
    referenceMessages: readonly Message[] = [],
  ): Promise<void> {
    const sender = message.from;
    const handler = this.#handler;
    if (sender === undefined || sender.is_bot || handler === undefined) return;
    if (!this.#allowedUserIds.has(sender.id)) {
      this.#logger.warn("Ignored Telegram message from unauthorized user", { userId: sender.id });
      return;
    }
    if (isTelegramTopicLifecycleMessage(message)) return;

    const guestQueryId = message.guest_query_id;
    if (guest && guestQueryId === undefined) return;
    const incomingRoute = guest ? undefined : routeTelegramMessage(message, sender.id);
    if (!guest && incomingRoute === undefined) {
      this.#logger.warn("Ignored unroutable Telegram direct message", {
        chatId: message.chat.id,
        messageId: message.message_id,
      });
      return;
    }
    const commandMatch = matchTelegramCommand(message, this.#botUsername);
    if (commandMatch.kind === "otherBot") return;
    const normalized =
      commandMatch.kind === "command"
        ? { text: message.text?.trim() ?? "", files: [] }
        : normalizeTelegramMessage(message, referenceMessages);
    const directory = join(this.#attachmentDirectory, crypto.randomUUID());
    const attachments: InboundAttachment[] = [];
    const failures: string[] = [];
    for (const [index, file] of normalized.files.entries()) {
      const description = describeTelegramFile(file);
      try {
        const path = await downloadTelegramFile(file, {
          api,
          apiRoot: this.#apiRoot,
          botToken: this.#token,
          directory,
          index,
        });
        attachments.push({
          kind: file.nativeImage ? "image" : file.voiceMessage === true ? "voice" : "file",
          path,
          description,
        });
      } catch (error) {
        this.#logger.warn("Could not download Telegram attachment", {
          messageId: message.message_id,
          description,
          error: errorMessage(error).replaceAll(this.#token, "<redacted>"),
        });
        const reason =
          error instanceof TelegramFileDownloadError
            ? error.userMessage
            : "Telegram could not download it; the cloud Bot API's 20 MB limit may apply";
        failures.push(`[${description} was not attached: ${reason}.]`);
      }
    }
    const text = [normalized.text, ...failures].filter((part) => part.length > 0).join("\n\n");
    const normalizedText = guest ? this.stripGuestMention(text) : text;
    if (normalizedText.length === 0) return;
    let responder: MessageResponder;
    let conversationKey: string;
    if (guest) {
      if (guestQueryId === undefined) return;
      responder = new TelegramGuestResponder(api, guestQueryId);
      conversationKey = `telegram:guest:${guestQueryId}`;
    } else {
      if (incomingRoute === undefined) return;
      responder = new TelegramResponder(
        api,
        message.chat,
        incomingRoute.reply,
        sender.id,
        this.requestChoice,
        this.#logger,
      );
      conversationKey = `telegram:${message.chat.id}:${incomingRoute.conversationSuffix}`;
    }
    const inbound: InboundMessage = {
      id: guest
        ? `guest:${guestQueryId}`
        : message.ephemeral_message_id === undefined
          ? String(message.message_id)
          : `ephemeral:${message.ephemeral_message_id}`,
      address: {
        channel: this.name,
        key: conversationKey,
        isPrivate: message.chat.type === "private",
        isGuest: guest,
        ...(guest || incomingRoute === undefined || incomingRoute.reply.visibility.kind !== "normal"
          ? {}
          : {
              deliveryTarget: telegramDeliveryTarget(
                message.chat.id,
                message.chat.type,
                incomingRoute.reply,
              ),
            }),
      },
      ...(guest
        ? {}
        : {
            reference: telegramMessageReference(message.chat.id, message.message_id),
            ...(message.reply_to_message === undefined
              ? {}
              : {
                  replyTo: telegramMessageReference(
                    message.chat.id,
                    message.reply_to_message.message_id,
                  ),
                }),
          }),
      sender: {
        id: String(sender.id),
        displayName: [sender.first_name, sender.last_name].filter(Boolean).join(" "),
      },
      text: normalizedText,
      ...(commandMatch.kind === "command" ? { command: commandMatch.command } : {}),
      attachments,
      responder,
    };
    try {
      await handler(inbound);
    } catch (error) {
      this.#logger.error("Telegram message handler failed", error, { messageId: inbound.id });
      await responder.sendText(`Bridge error: ${errorMessage(error)}`).catch(() => undefined);
    }
  }

  private readonly requestChoice: ChoiceRequester = async (
    chat: Chat,
    route: TelegramReplyRoute,
    userId: number,
    prompt: string,
    options: readonly ChoiceOption[],
  ): Promise<string> => {
    if (options.length === 0) return "decline";
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const details = options
      .filter((option) => option.description !== undefined)
      .map((option) => `${option.label}: ${option.description}`)
      .join("\n");
    const body = details.length === 0 ? prompt : `${prompt}\n\n${details}`;
    const sent = await this.#bot.api.sendMessage(
      chat.id,
      body.length <= 4_096 ? body : `${body.slice(0, 4_095)}…`,
      {
        ...telegramSendParameters(route),
        reply_markup: {
          inline_keyboard: options.map((option, index) => [
            {
              text: option.label.slice(0, 64),
              callback_data: `cb:${token}:${index}`,
            },
          ]),
        },
      },
    );
    const sentMessage = pendingChoiceMessage(route, sent);
    const result = deferred<string>();
    const timer = setTimeout(
      () => {
        this.#pendingChoices.delete(token);
        result.resolve("decline");
      },
      5 * 60 * 1_000,
    );
    timer.unref();
    this.#pendingChoices.set(token, {
      userId,
      options,
      result,
      timer,
      chatId: chat.id,
      message: sentMessage,
    });
    return await result.promise;
  };

  private async handleCallback(query: CallbackQuery, api: Api): Promise<void> {
    if (!this.#allowedUserIds.has(query.from.id) || query.data === undefined) return;
    const command = decodeCommandCallback(query.data);
    if (command !== undefined) {
      await this.handleCommandCallback(query, command, api);
      return;
    }
    const match = /^cb:([0-9a-f]{16}):(\d+)$/.exec(query.data);
    if (match === null) return;
    const token = match[1];
    const index = Number(match[2]);
    if (token === undefined) return;
    const pending = this.#pendingChoices.get(token);
    if (pending === undefined || pending.userId !== query.from.id) {
      await api.answerCallbackQuery(query.id, { text: "This choice has expired." });
      return;
    }
    const selected = pending.options[index];
    if (selected === undefined) return;
    clearTimeout(pending.timer);
    this.#pendingChoices.delete(token);
    pending.result.resolve(selected.id);
    const clearKeyboard =
      pending.message.kind === "normal"
        ? api.editMessageReplyMarkup(pending.chatId, pending.message.messageId, {
            reply_markup: { inline_keyboard: [] },
          })
        : api.editEphemeralMessageReplyMarkup(
            pending.chatId,
            pending.message.receiverUserId,
            pending.message.ephemeralMessageId,
            { reply_markup: { inline_keyboard: [] } },
          );
    await Promise.allSettled([
      api.answerCallbackQuery(query.id, { text: selected.label.slice(0, 200) }),
      clearKeyboard,
    ]);
  }

  private async handleCommandCallback(
    query: CallbackQuery,
    command: Readonly<{ name: string; args: string }>,
    api: Api,
  ): Promise<void> {
    const handler = this.#handler;
    const message = query.message;
    if (handler === undefined || message === undefined || !("date" in message)) {
      await api.answerCallbackQuery(query.id, { text: "This action is unavailable." });
      return;
    }
    const incomingRoute = routeTelegramMessage(message, query.from.id);
    if (incomingRoute === undefined) {
      await api.answerCallbackQuery(query.id, { text: "This action is unavailable." });
      return;
    }
    const responder = new TelegramResponder(
      api,
      message.chat,
      incomingRoute.reply,
      query.from.id,
      this.requestChoice,
      this.#logger,
    );
    const inbound: InboundMessage = {
      id: `callback:${query.id}`,
      address: {
        channel: this.name,
        key: `telegram:${message.chat.id}:${incomingRoute.conversationSuffix}`,
        isPrivate: message.chat.type === "private",
        isGuest: false,
        deliveryTarget: telegramDeliveryTarget(
          message.chat.id,
          message.chat.type,
          incomingRoute.reply,
        ),
      },
      reference: telegramMessageReference(message.chat.id, message.message_id),
      sender: {
        id: String(query.from.id),
        displayName: [query.from.first_name, query.from.last_name].filter(Boolean).join(" "),
      },
      text: `/${command.name}${command.args.length === 0 ? "" : ` ${command.args}`}`,
      command,
      attachments: [],
      responder,
    };
    await api.answerCallbackQuery(query.id, { text: "Opening scheduled run…" });
    try {
      await handler(inbound);
    } catch (error) {
      this.#logger.error("Telegram command action failed", error, { command: command.name });
      await responder.sendText(`Bridge error: ${errorMessage(error)}`).catch(() => undefined);
    }
  }

  private stripGuestMention(text: string): string {
    const username = this.#botUsername;
    if (username === undefined) return text;
    return text.replace(new RegExp(`@${username}\\b`, "gi"), "").trim();
  }
}

function pendingChoiceMessage(route: TelegramReplyRoute, sent: Message): PendingChoiceMessage {
  if (route.visibility.kind === "normal") {
    return { kind: "normal", messageId: sent.message_id };
  }
  const ephemeralMessageId = sent.ephemeral_message_id;
  if (ephemeralMessageId === undefined) {
    throw new Error("Telegram did not return an ephemeral message identifier");
  }
  return {
    kind: "ephemeral",
    receiverUserId: route.visibility.receiverUserId,
    ephemeralMessageId,
  };
}

function describeTelegramFile(file: TelegramFileReference): string {
  const metadata = [
    file.suggestedName,
    file.mimeType,
    file.size === undefined ? undefined : formatBytes(file.size),
  ].filter((value): value is string => value !== undefined);
  return metadata.length === 0 ? file.description : `${file.description} (${metadata.join(", ")})`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${Math.round((bytes / (1_024 * 1_024)) * 10) / 10} MB`;
}
