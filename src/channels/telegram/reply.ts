import { basename, extname } from "node:path";
import { type Api, InputFile } from "grammy";
import type { Chat, InlineKeyboardMarkup, InputRichMessageWithoutUpload } from "grammy/types";
import type {
  ChoiceOption,
  MessageResponder,
  OutboundAttachment,
  OutboundStream,
  ProgressSnapshot,
  SendOptions,
} from "../../core/channel.js";
import type { Logger } from "../../shared/logger.js";
import type { TelegramDestination, TelegramReplyRoute } from "./route.js";

export type ChoiceRequester = (
  chat: Chat,
  route: TelegramReplyRoute,
  userId: number,
  prompt: string,
  options: readonly ChoiceOption[],
) => Promise<string>;

interface TelegramDestinationParameters {
  readonly message_thread_id?: number;
  readonly direct_messages_topic_id?: number;
}

export interface TelegramSendParameters extends TelegramDestinationParameters {
  readonly receiver_user_id?: number;
  readonly reply_parameters?:
    | { readonly message_id: number }
    | { readonly ephemeral_message_id: number };
}

function destinationParameters(destination: TelegramDestination): TelegramDestinationParameters {
  switch (destination.kind) {
    case "topic":
      return { message_thread_id: destination.messageThreadId };
    case "directMessagesTopic":
      return { direct_messages_topic_id: destination.directMessagesTopicId };
    case "chat":
    case "genericThread":
      return {};
  }
}

function normalMessageParameters(route: TelegramReplyRoute): TelegramSendParameters {
  const destination = destinationParameters(route.destination);
  return route.destination.kind === "genericThread"
    ? {
        ...destination,
        reply_parameters: { message_id: route.destination.replyToMessageId },
      }
    : destination;
}

export function telegramSendParameters(route: TelegramReplyRoute): TelegramSendParameters {
  if (route.visibility.kind === "normal") return normalMessageParameters(route);
  return {
    ...destinationParameters(route.destination),
    receiver_user_id: route.visibility.receiverUserId,
    reply_parameters: {
      ephemeral_message_id: route.visibility.incomingEphemeralMessageId,
    },
  };
}

function activityParameters(route: TelegramReplyRoute): Readonly<{ message_thread_id?: number }> {
  switch (route.destination.kind) {
    case "topic":
      return { message_thread_id: route.destination.messageThreadId };
    case "genericThread":
      return { message_thread_id: route.destination.replyToMessageId };
    case "chat":
    case "directMessagesTopic":
      return {};
  }
}

function keyboard(options: SendOptions | undefined): InlineKeyboardMarkup | undefined {
  const button = options?.button;
  if (button === undefined) return undefined;
  return {
    inline_keyboard: [
      [
        button.kind === "webApp"
          ? { text: button.label, web_app: { url: button.url } }
          : { text: button.label, url: button.url },
      ],
    ],
  };
}

export class TelegramResponder implements MessageResponder {
  readonly #api: Api;
  readonly #chat: Chat;
  readonly #route: TelegramReplyRoute;
  readonly #userId: number;
  readonly #requestChoice: ChoiceRequester;
  readonly #logger: Logger;
  #outgoingEphemeralMessageId: number | undefined;

  public constructor(
    api: Api,
    chat: Chat,
    route: TelegramReplyRoute,
    userId: number,
    requestChoice: ChoiceRequester,
    logger: Logger,
  ) {
    this.#api = api;
    this.#chat = chat;
    this.#route = route;
    this.#userId = userId;
    this.#requestChoice = requestChoice;
    this.#logger = logger;
  }

  public createStream(): OutboundStream {
    return new TelegramReplyStream(this.#api, this.#chat, this.#route, this.#logger);
  }

  public async sendText(text: string, options?: SendOptions): Promise<void> {
    const replyMarkup = keyboard(options);
    const visibility = this.#route.visibility;
    if (visibility.kind === "ephemeral" && this.#outgoingEphemeralMessageId !== undefined) {
      await this.#api.editEphemeralMessageText(
        this.#chat.id,
        visibility.receiverUserId,
        this.#outgoingEphemeralMessageId,
        truncateTelegramText(text),
        replyMarkup === undefined ? {} : { reply_markup: replyMarkup },
      );
      return;
    }

    if (replyMarkup !== undefined) {
      const sent = await this.#api.sendMessage(this.#chat.id, truncateTelegramText(text), {
        ...telegramSendParameters(this.#route),
        reply_markup: replyMarkup,
      });
      this.rememberEphemeralMessage(sent.ephemeral_message_id);
      return;
    }
    for (const chunk of splitTelegramText(text)) {
      const sent = await this.#api.sendMessage(
        this.#chat.id,
        chunk,
        telegramSendParameters(this.#route),
      );
      this.rememberEphemeralMessage(sent.ephemeral_message_id);
    }
  }

  public async askChoice(prompt: string, options: readonly ChoiceOption[]): Promise<string> {
    return await this.#requestChoice(this.#chat, this.#route, this.#userId, prompt, options);
  }

  private rememberEphemeralMessage(ephemeralMessageId: number | undefined): void {
    if (this.#route.visibility.kind === "ephemeral" && ephemeralMessageId !== undefined) {
      this.#outgoingEphemeralMessageId = ephemeralMessageId;
    }
  }
}

export class TelegramGuestResponder implements MessageResponder {
  #answered = false;
  #answering: Promise<void> | undefined;
  readonly #api: Api;
  readonly #guestQueryId: string;

  public constructor(api: Api, guestQueryId: string) {
    this.#api = api;
    this.#guestQueryId = guestQueryId;
  }

  public createStream(): OutboundStream {
    return new TelegramGuestReplyStream(this);
  }

  public async sendText(text: string): Promise<void> {
    await this.answer(text);
  }

  public async askChoice(_prompt: string, _options: readonly ChoiceOption[]): Promise<string> {
    return "decline";
  }

  public async answer(text: string): Promise<void> {
    if (this.#answered) return;
    if (this.#answering !== undefined) return await this.#answering;
    this.#answering = this.sendAnswer(text).then(() => {
      this.#answered = true;
    });
    try {
      await this.#answering;
    } finally {
      this.#answering = undefined;
    }
  }

  private async sendAnswer(text: string): Promise<void> {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const result = {
      type: "article" as const,
      id,
      title: "Codex",
      input_message_content: { rich_message: { markdown: text.slice(0, 8_000) } },
    };
    try {
      await this.#api.answerGuestQuery(this.#guestQueryId, result);
    } catch {
      await this.#api.answerGuestQuery(this.#guestQueryId, {
        type: "article",
        id,
        title: "Codex",
        input_message_content: { message_text: truncateTelegramText(text) },
      });
    }
  }
}

class TelegramGuestReplyStream implements OutboundStream {
  readonly #responder: TelegramGuestResponder;

  public constructor(responder: TelegramGuestResponder) {
    this.#responder = responder;
  }

  public async start(_initialProgress?: ProgressSnapshot): Promise<void> {}
  public setProgress(_progress: ProgressSnapshot): void {}
  public appendFinal(_delta: string): void {}

  public async complete(
    text: string,
    attachments: readonly OutboundAttachment[] = [],
  ): Promise<void> {
    const attachmentNote =
      attachments.length === 0
        ? ""
        : `Generated files can only be attached in a direct chat with this bot: ${attachments
            .map((attachment) => safeAttachmentName(attachment.filename))
            .join(", ")}${text.length === 0 ? "" : "\n\n"}`;
    await this.#responder.answer(attachmentNote + text);
  }

  public async fail(message: string): Promise<void> {
    await this.#responder.answer(`Codex error: ${message}`);
  }
}

class TelegramReplyStream implements OutboundStream {
  static readonly #draftIntervalMs = 250;
  readonly #draftId = Math.floor(Math.random() * 2_000_000_000) + 1;
  #progress: ProgressSnapshot = { actions: [], plan: [] };
  #finalText = "";
  #draftMode: "rich" | "plain" | "none";
  #lastDraftAt = 0;
  #hasPublishedContent = false;
  #draftDirty = false;
  #draftTimer: NodeJS.Timeout | undefined;
  #draftInFlight: Promise<void> | undefined;
  #typingTimer: NodeJS.Timeout | undefined;
  #completed = false;
  readonly #api: Api;
  readonly #chat: Chat;
  readonly #route: TelegramReplyRoute;
  readonly #logger: Logger;

  public constructor(api: Api, chat: Chat, route: TelegramReplyRoute, logger: Logger) {
    this.#api = api;
    this.#chat = chat;
    this.#route = route;
    this.#logger = logger;
    this.#draftMode =
      chat.type === "private" &&
      route.visibility.kind === "normal" &&
      route.destination.kind !== "directMessagesTopic"
        ? "rich"
        : "none";
  }

  public async start(initialProgress?: ProgressSnapshot): Promise<void> {
    if (initialProgress !== undefined) this.#progress = initialProgress;
    if (this.#draftMode !== "none") await this.flushDraft();
    else this.startTyping();
  }

  public setProgress(progress: ProgressSnapshot): void {
    this.#progress = progress;
    this.scheduleDraft(!this.#hasPublishedContent);
  }

  public appendFinal(delta: string): void {
    this.#finalText += delta;
    this.scheduleDraft(!this.#hasPublishedContent);
  }

  public async complete(
    text: string,
    attachments: readonly OutboundAttachment[] = [],
  ): Promise<void> {
    if (this.#completed) return;
    this.#completed = true;
    this.clearTimers();
    await this.#draftInFlight?.catch(() => undefined);
    if (text.length > 0) {
      try {
        await this.sendFinal(text);
      } catch (error) {
        this.#logger.warn("Telegram final text delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.sendAttachments(attachments);
  }

  public async fail(message: string): Promise<void> {
    await this.complete(`Codex error: ${message}`);
  }

  private scheduleDraft(immediate = false): void {
    if (this.#completed || this.#draftMode === "none") return;
    this.#draftDirty = true;
    if (this.#draftInFlight !== undefined) return;

    const wait = immediate
      ? 0
      : Math.max(0, TelegramReplyStream.#draftIntervalMs - (Date.now() - this.#lastDraftAt));
    if (wait === 0) {
      this.startDraftUpdate();
      return;
    }
    if (this.#draftTimer !== undefined) return;
    this.#draftTimer = setTimeout(() => {
      this.#draftTimer = undefined;
      this.startDraftUpdate();
    }, wait);
    this.#draftTimer.unref();
  }

  private startDraftUpdate(): void {
    if (
      this.#completed ||
      this.#draftMode === "none" ||
      this.#draftInFlight !== undefined ||
      !this.#draftDirty
    ) {
      return;
    }

    this.#draftDirty = false;
    const update = this.flushDraft().catch((error: unknown) => {
      this.#logger.debug("Telegram draft update failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.#draftInFlight = update;
    void update.finally(() => {
      if (this.#draftInFlight === update) this.#draftInFlight = undefined;
      if (this.#draftDirty) this.scheduleDraft(!this.#hasPublishedContent);
    });
  }

  private async flushDraft(): Promise<void> {
    if (this.#completed || this.#draftMode === "none") return;
    this.#lastDraftAt = Date.now();
    if (this.#draftMode === "rich") {
      const richMessage: InputRichMessageWithoutUpload = {
        blocks: [
          {
            type: "thinking",
            text: formatThinkingBlock(this.#progress),
          },
          ...(this.#finalText.length === 0
            ? []
            : [{ type: "paragraph" as const, text: this.#finalText.slice(-8_000) }]),
        ],
      };
      try {
        await this.#api.sendRichMessageDraft(this.#chat.id, this.#draftId, richMessage, {
          ...activityParameters(this.#route),
        });
        this.#hasPublishedContent ||= this.hasContent();
        return;
      } catch {
        this.#draftMode = "plain";
      }
    }

    try {
      const preview = (this.#finalText || formatThinkingBlock(this.#progress)).slice(-4_096);
      await this.#api.sendMessageDraft(this.#chat.id, this.#draftId, preview, {
        ...activityParameters(this.#route),
      });
      this.#hasPublishedContent ||= this.hasContent();
    } catch {
      this.#draftMode = "none";
      this.startTyping();
    }
  }

  private hasContent(): boolean {
    return (
      this.#finalText.length > 0 ||
      this.#progress.summary !== undefined ||
      this.#progress.message !== undefined ||
      this.#progress.actions.length > 0 ||
      this.#progress.plan.length > 0
    );
  }

  private startTyping(): void {
    if (
      this.#route.visibility.kind === "ephemeral" ||
      this.#route.destination.kind === "directMessagesTopic"
    ) {
      return;
    }
    const send = (): void => {
      void this.#api
        .sendChatAction(this.#chat.id, "typing", { ...activityParameters(this.#route) })
        .catch(() => undefined);
    };
    send();
    if (this.#typingTimer === undefined) {
      this.#typingTimer = setInterval(send, 4_000);
      this.#typingTimer.unref();
    }
  }

  private async sendFinal(text: string): Promise<void> {
    if (this.#route.visibility.kind === "normal") {
      try {
        await this.#api.sendRichMessage(
          this.#chat.id,
          { markdown: text },
          normalMessageParameters(this.#route),
        );
        return;
      } catch (error) {
        this.#logger.debug("Rich Telegram message failed; using plain chunks", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const chunk of splitTelegramText(text)) {
      await this.#api.sendMessage(this.#chat.id, chunk, telegramSendParameters(this.#route));
    }
  }

  private async sendAttachments(attachments: readonly OutboundAttachment[]): Promise<void> {
    const failed: string[] = [];
    for (const attachment of attachments) {
      if (!(await this.sendAttachment(attachment)))
        failed.push(safeAttachmentName(attachment.filename));
    }
    if (failed.length === 0) return;

    const message = `Could not send ${failed.join(", ")} as ${failed.length === 1 ? "an attachment" : "attachments"}.`;
    try {
      for (const chunk of splitTelegramText(message)) {
        await this.#api.sendMessage(this.#chat.id, chunk, telegramSendParameters(this.#route));
      }
    } catch (error) {
      this.#logger.warn("Telegram attachment failure notice could not be sent", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendAttachment(attachment: OutboundAttachment): Promise<boolean> {
    const filename = safeAttachmentName(attachment.filename);
    const input = (): InputFile => new InputFile(attachment.path, filename);
    const params = telegramSendParameters(this.#route);
    const kind = telegramAttachmentKind(attachment.path);

    try {
      switch (kind) {
        case "photo":
          await this.#api.sendPhoto(this.#chat.id, input(), params);
          return true;
        case "animation":
          await this.#api.sendAnimation(this.#chat.id, input(), params);
          return true;
        case "video":
          await this.#api.sendVideo(this.#chat.id, input(), params);
          return true;
        case "audio":
          await this.#api.sendAudio(this.#chat.id, input(), params);
          return true;
        case "document":
          await this.#api.sendDocument(this.#chat.id, input(), params);
          return true;
      }
    } catch (error) {
      let uploadError = error;
      if (kind !== "document") {
        this.#logger.debug("Native Telegram attachment failed; using document", {
          filename,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await this.#api.sendDocument(this.#chat.id, input(), params);
          return true;
        } catch (fallbackError) {
          uploadError = fallbackError;
        }
      }
      this.#logger.warn("Telegram attachment upload failed", {
        filename,
        error: uploadError instanceof Error ? uploadError.message : String(uploadError),
      });
    }
    return false;
  }

  private clearTimers(): void {
    if (this.#draftTimer !== undefined) clearTimeout(this.#draftTimer);
    if (this.#typingTimer !== undefined) clearInterval(this.#typingTimer);
    this.#draftTimer = undefined;
    this.#typingTimer = undefined;
  }
}

type TelegramAttachmentKind = "photo" | "animation" | "video" | "audio" | "document";

function telegramAttachmentKind(path: string): TelegramAttachmentKind {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
    case ".png":
      return "photo";
    case ".gif":
      return "animation";
    case ".mp4":
      return "video";
    case ".mp3":
    case ".m4a":
      return "audio";
    default:
      return "document";
  }
}

function safeAttachmentName(path: string): string {
  return basename(path).replace(/[\r\n]/g, "_") || "attachment";
}

export function formatThinkingBlock(progress: ProgressSnapshot, limit = 800): string {
  const text =
    progress.plan.length > 1 ? formatPlanProgress(progress) : formatActionProgress(progress);
  if (text.length <= limit) return text;
  if (limit <= 1) return "…".slice(0, limit);
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function formatActionProgress(progress: ProgressSnapshot): string {
  const heading = firstLine(progress.summary) || firstLine(progress.message) || "Thinking…";
  const maximumVisibleActions = 4;
  const hiddenActions = Math.max(0, progress.actions.length - maximumVisibleActions);
  const visibleActions = progress.actions.slice(-maximumVisibleActions);
  const rows = [
    ...(hiddenActions === 0 ? [] : [`<${hiddenActions} more actions>`]),
    ...visibleActions.map((action) => action.label),
  ];
  return [
    `▌ ${truncateLine(heading, 180)}`,
    ...rows.map(
      (row, index) => `${index === rows.length - 1 ? "└" : "├"} ${truncateLine(row, 180)}`,
    ),
  ].join("\n");
}

function formatPlanProgress(progress: ProgressSnapshot): string {
  const currentIndex = progress.plan.findIndex((step) => step.status === "inProgress");
  const fallbackIndex = progress.plan.findIndex((step) => step.status === "pending");
  const activeIndex = currentIndex === -1 ? fallbackIndex : currentIndex;
  const context = firstLine(progress.summary) || progress.actions.at(-1)?.label || "";
  const reasoningMessage = progress.message?.trim();
  const lines: string[] = [];

  progress.plan.forEach((step, index) => {
    const isCurrent = index === activeIndex;
    if (isCurrent && lines.length > 0) lines.push("");
    const marker = step.status === "completed" ? "✓" : isCurrent ? "→" : "○";
    const suffix = isCurrent && context.length > 0 ? ` (${truncateLine(context, 140)})` : "";
    lines.push(`${marker} ${truncateLine(step.step, 180)}${suffix}`);
    if (isCurrent && reasoningMessage !== undefined && reasoningMessage !== context) {
      lines.push(truncateLine(reasoningMessage, 240));
    }
    if (isCurrent && index < progress.plan.length - 1) lines.push("");
  });

  return lines.join("\n");
}

function firstLine(text: string | undefined): string {
  return text?.trim().split("\n", 1)[0]?.trim() ?? "";
}

function truncateLine(text: string, limit: number): string {
  const compact = text.replaceAll(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

export function splitTelegramText(text: string, limit = 4_096): readonly string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const newline = candidate.lastIndexOf("\n");
    const splitAt = newline > limit / 2 ? newline : limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function truncateTelegramText(text: string, limit = 4_096): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}
