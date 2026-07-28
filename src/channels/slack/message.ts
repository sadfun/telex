import { mrkdwnToPlainText } from "./format.js";

/** Subset of a Slack file object relevant to attachment handling. */
export interface SlackFile {
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
  readonly mimetype?: string;
  readonly size?: number;
  readonly mode?: string;
  readonly subtype?: string;
  readonly url_private?: string;
  readonly url_private_download?: string;
}

/** Subset of a Slack Events API `message` event relevant to the bridge. */
export interface SlackMessageEvent {
  readonly type: "message";
  readonly subtype?: string;
  readonly channel: string;
  readonly channel_type: "im" | "channel" | "group" | "mpim";
  readonly user?: string;
  readonly bot_id?: string;
  readonly text?: string;
  readonly ts: string;
  readonly thread_ts?: string;
  readonly files?: readonly SlackFile[];
}

export interface SlackIncomingRoute {
  /** Stable per-conversation suffix: `main` for DMs, the thread root ts elsewhere. */
  readonly conversationSuffix: string;
  /** Thread to reply into; undefined keeps DM replies unthreaded. */
  readonly replyThreadTs: string | undefined;
}

const handledSubtypes = new Set([undefined, "file_share", "thread_broadcast"]);

/**
 * Decide whether and where to handle a message event.
 *
 * DMs are always handled. In channels and group DMs the bot answers when it
 * is mentioned, or when the message continues a thread it already works in.
 */
export function routeSlackMessage(
  event: SlackMessageEvent,
  botUserId: string,
  isThreadActive: (conversationSuffix: string) => boolean,
): SlackIncomingRoute | undefined {
  if (!handledSubtypes.has(event.subtype)) return undefined;
  if (event.bot_id !== undefined || event.user === undefined || event.user === botUserId) {
    return undefined;
  }
  if (event.channel_type === "im") {
    return { conversationSuffix: "main", replyThreadTs: undefined };
  }
  const threadRoot = event.thread_ts ?? event.ts;
  const mentioned = event.text?.includes(`<@${botUserId}>`) === true;
  if (!mentioned && !(event.thread_ts !== undefined && isThreadActive(event.thread_ts))) {
    return undefined;
  }
  return { conversationSuffix: threadRoot, replyThreadTs: threadRoot };
}

export interface NormalizedSlackMessage {
  readonly text: string;
  readonly files: readonly SlackFile[];
}

export function normalizeSlackMessage(
  event: SlackMessageEvent,
  botUserId: string,
): NormalizedSlackMessage {
  const withoutBotMention = (event.text ?? "")
    .replaceAll(`<@${botUserId}>`, " ")
    .replaceAll(/[ \t]{2,}/gu, " ");
  return {
    text: mrkdwnToPlainText(withoutBotMention).trim(),
    files: event.files ?? [],
  };
}

export function describeSlackFile(file: SlackFile): string {
  const name = file.name ?? file.title ?? "attachment";
  const metadata = [
    file.mimetype,
    file.size === undefined ? undefined : formatBytes(file.size),
  ].filter((value): value is string => value !== undefined);
  return metadata.length === 0 ? name : `${name} (${metadata.join(", ")})`;
}

export function slackAttachmentKind(file: SlackFile): "image" | "file" | "voice" {
  if (file.subtype === "slack_audio") return "voice";
  const mimetype = file.mimetype ?? "";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("audio/")) return "voice";
  return "file";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${Math.round((bytes / (1_024 * 1_024)) * 10) / 10} MB`;
}
