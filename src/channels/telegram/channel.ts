import { type RunnerHandle, run } from "@grammyjs/runner";
import { type Api, Bot } from "grammy";
import type { CallbackQuery, Chat, Message } from "grammy/types";
import type {
  ChoiceOption,
  InboundMessage,
  MessageHandler,
  MessagingChannel,
} from "../../core/channel.js";
import { type Deferred, deferred } from "../../shared/async.js";
import { errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import { type ChoiceRequester, TelegramGuestResponder, TelegramResponder } from "./reply.js";

interface PendingChoice {
  readonly userId: number;
  readonly options: readonly ChoiceOption[];
  readonly result: Deferred<string>;
  readonly timer: NodeJS.Timeout;
  readonly chatId: number;
  readonly messageId: number;
}

export class TelegramChannel implements MessagingChannel {
  public readonly name = "telegram";
  readonly #bot: Bot;
  readonly #allowedUserIds: ReadonlySet<number>;
  readonly #pollTimeout: number;
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
    logger: Logger,
  ) {
    this.#allowedUserIds = allowedUserIds;
    this.#pollTimeout = pollTimeout;
    this.#logger = logger;
    this.#bot = new Bot(token, { client: { apiRoot } });
    this.#bot.on("message:text", async (context) => {
      await this.handleMessage(context.message, false, context.api);
    });
    this.#bot.on("guest_message:text", async (context) => {
      await this.handleMessage(context.guestMessage, true, context.api);
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
    await this.#bot.api
      .setMyCommands([
        { command: "new", description: "Start a new Codex task", is_ephemeral: true },
        { command: "stop", description: "Stop the running turn", is_ephemeral: true },
        { command: "status", description: "Show Codex status", is_ephemeral: true },
        { command: "login", description: "Sign in to Codex", is_ephemeral: true },
        { command: "logout", description: "Sign out of Codex", is_ephemeral: true },
        { command: "config", description: "Open Codex settings", is_ephemeral: true },
        { command: "update", description: "Update Telex", is_ephemeral: true },
        { command: "help", description: "Show commands", is_ephemeral: true },
      ])
      .catch((error: unknown) => {
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

  public async stop(): Promise<void> {
    await this.#runner?.stop();
    for (const choice of this.#pendingChoices.values()) {
      clearTimeout(choice.timer);
      choice.result.resolve("decline");
    }
    this.#pendingChoices.clear();
  }

  private async handleMessage(
    message: Message.TextMessage,
    guest: boolean,
    api: Api,
  ): Promise<void> {
    const sender = message.from;
    const handler = this.#handler;
    if (sender === undefined || sender.is_bot || handler === undefined) return;
    if (!this.#allowedUserIds.has(sender.id)) {
      this.#logger.warn("Ignored Telegram message from unauthorized user", { userId: sender.id });
      return;
    }

    const text = message.text.trim();
    if (text.length === 0) return;
    const guestQueryId = message.guest_query_id;
    if (guest && guestQueryId === undefined) return;
    const normalizedText = guest ? this.stripGuestMention(text) : text;
    const threadId = message.message_thread_id;
    const responder = guest
      ? new TelegramGuestResponder(api, guestQueryId as string)
      : new TelegramResponder(
          api,
          message.chat,
          threadId,
          sender.id,
          this.requestChoice,
          this.#logger,
        );
    const inbound: InboundMessage = {
      id: guest ? `guest:${guestQueryId}` : String(message.message_id),
      address: {
        channel: this.name,
        key: guest
          ? `telegram:guest:${guestQueryId}`
          : `telegram:${message.chat.id}:${threadId ?? 0}`,
        isPrivate: message.chat.type === "private",
        isGuest: guest,
      },
      sender: {
        id: String(sender.id),
        displayName: [sender.first_name, sender.last_name].filter(Boolean).join(" "),
      },
      text: normalizedText,
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
    threadId: number | undefined,
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
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
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
      messageId: sent.message_id,
    });
    return await result.promise;
  };

  private async handleCallback(query: CallbackQuery, api: Api): Promise<void> {
    if (!this.#allowedUserIds.has(query.from.id) || query.data === undefined) return;
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
    await Promise.allSettled([
      api.answerCallbackQuery(query.id, { text: selected.label.slice(0, 200) }),
      api.editMessageReplyMarkup(pending.chatId, pending.messageId, {
        reply_markup: { inline_keyboard: [] },
      }),
    ]);
  }

  private stripGuestMention(text: string): string {
    const username = this.#botUsername;
    if (username === undefined) return text;
    return text.replace(new RegExp(`@${username}\\b`, "gi"), "").trim();
  }
}
