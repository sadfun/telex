import { basename, extname } from "node:path";
import type {
  Message,
  MessageOrigin,
  PhotoSize,
  RichBlock,
  RichBlockCaption,
  RichText,
} from "grammy/types";

export interface TelegramFileReference {
  readonly fileId: string;
  readonly uniqueId: string;
  readonly description: string;
  readonly suggestedName: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly nativeImage: boolean;
  readonly voiceMessage?: boolean;
}

export interface NormalizedTelegramMessage {
  readonly text: string;
  readonly files: readonly TelegramFileReference[];
}

type ContextKind = "current" | "reply" | "external" | "reference";

interface FileLike {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

interface NormalizeState {
  readonly files: TelegramFileReference[];
  readonly fileIds: Set<string>;
  readonly scanned: WeakSet<object>;
}

const NATIVE_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const NATIVE_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const FILE_SCAN_SKIP_KEYS = new Set([
  "thumbnail",
  "cover",
  "qualities",
  "passport_data",
  "reply_to_message",
  "external_reply",
  "reference_messages",
]);

const HANDLED_MESSAGE_KEYS = new Set([
  "message_id",
  "message_thread_id",
  "direct_messages_topic",
  "from",
  "sender_chat",
  "sender_boost_count",
  "sender_business_bot",
  "sender_tag",
  "receiver_user",
  "ephemeral_message_id",
  "date",
  "guest_query_id",
  "business_connection_id",
  "chat",
  "forward_origin",
  "is_topic_message",
  "is_automatic_forward",
  "reply_to_message",
  "external_reply",
  "reference_messages",
  "quote",
  "reply_to_story",
  "reply_to_checklist_task_id",
  "reply_to_poll_option_id",
  "via_bot",
  "guest_bot_caller_user",
  "guest_bot_caller_chat",
  "edit_date",
  "has_protected_content",
  "is_from_offline",
  "is_paid_post",
  "media_group_id",
  "author_signature",
  "paid_star_count",
  "entities",
  "caption_entities",
  "link_preview_options",
  "effect_id",
  "reply_markup",
  "show_caption_above_media",
  "has_media_spoiler",
  "text",
  "caption",
  "rich_message",
  "animation",
  "audio",
  "document",
  "live_photo",
  "paid_media",
  "photo",
  "sticker",
  "story",
  "video",
  "video_note",
  "voice",
  "checklist",
  "contact",
  "dice",
  "game",
  "poll",
  "venue",
  "location",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
]);

export function isTelegramTopicLifecycleMessage(message: Message): boolean {
  return (
    message.forum_topic_created !== undefined ||
    message.forum_topic_edited !== undefined ||
    message.forum_topic_closed !== undefined ||
    message.forum_topic_reopened !== undefined ||
    message.general_forum_topic_hidden !== undefined ||
    message.general_forum_topic_unhidden !== undefined
  );
}

export function normalizeTelegramMessage(
  message: Message,
  referenceMessages: readonly Message[] = [],
): NormalizedTelegramMessage {
  const state: NormalizeState = {
    files: [],
    fileIds: new Set(),
    scanned: new WeakSet(),
  };
  const lines: string[] = [];
  for (const reference of referenceMessages) {
    if (isTelegramTopicLifecycleMessage(reference)) continue;
    lines.push(`Referenced message from ${messageActor(reference)}:`);
    lines.push(...indent(describeMessage(reference, state, "reference")));
  }
  lines.push(...describeMessage(message, state, "current"));
  const text = cleanLines(lines).join("\n").trim() || "[Telegram message]";
  return { text, files: state.files };
}

function describeMessage(message: Message, state: NormalizeState, context: ContextKind): string[] {
  const lines: string[] = [];

  if (message.forward_origin !== undefined) {
    lines.push(`Forwarded from ${describeOrigin(message.forward_origin)}`);
  }
  if (
    message.reply_to_message !== undefined &&
    !isTelegramTopicLifecycleMessage(message.reply_to_message)
  ) {
    lines.push(`Replying to ${messageActor(message.reply_to_message)}:`);
    lines.push(...indent(describeMessage(message.reply_to_message, state, "reply")));
  }
  if (message.external_reply !== undefined) {
    lines.push(`External reply to ${describeOrigin(message.external_reply.origin)}:`);
    lines.push(
      ...indent(describePayload(message.external_reply as unknown as Message, state, "external")),
    );
    scanAccessibleFiles(message.external_reply, state, "external", "external reply");
  }
  if (message.quote !== undefined) {
    lines.push(`Quote: ${message.quote.text}`);
  }
  if (message.reply_to_story !== undefined) {
    lines.push(
      `Replying to story #${message.reply_to_story.id} from ${chatName(message.reply_to_story.chat)}`,
    );
  }
  if (message.reply_to_checklist_task_id !== undefined) {
    lines.push(`Replying to checklist task #${message.reply_to_checklist_task_id}`);
  }
  if (message.reply_to_poll_option_id !== undefined) {
    lines.push(`Replying to poll option ${message.reply_to_poll_option_id}`);
  }

  lines.push(...describePayload(message, state, context));
  lines.push(...genericMessageFallback(message));
  scanAccessibleFiles(message, state, context, "message");
  return cleanLines(lines);
}

function describePayload(message: Message, state: NormalizeState, context: ContextKind): string[] {
  const lines: string[] = [];
  const text = message.text?.trim();
  const caption = message.caption?.trim();
  if (text) lines.push(text);
  if (caption && caption !== text) lines.push(caption);
  const hasWords =
    (text !== undefined && text.length > 0) || (caption !== undefined && caption.length > 0);
  const mediaLabels: string[] = [];

  if (message.rich_message !== undefined) {
    const rich = describeRichBlocks(message.rich_message.blocks, state, context);
    lines.push(...(rich.length > 0 ? rich : ["[Rich message]"]));
  }
  if (message.animation !== undefined) {
    addStandardFile(
      state,
      context,
      "animation",
      message.animation,
      animationName(message.animation),
    );
    mediaLabels.push("Animation");
  }
  if (message.audio !== undefined) {
    addStandardFile(state, context, "audio", message.audio, audioName(message.audio));
    mediaLabels.push(message.audio.title ? `Audio: ${message.audio.title}` : "Audio");
  }
  if (message.document !== undefined && message.animation === undefined) {
    addStandardFile(state, context, "document", message.document, "document.bin");
    mediaLabels.push(
      message.document.file_name
        ? `Document: ${safeName(message.document.file_name, "document")}`
        : "Document",
    );
  }
  if (message.live_photo !== undefined) {
    addLivePhoto(state, context, message.live_photo, "live photo");
    mediaLabels.push("Live photo");
  } else if (message.photo !== undefined) {
    addPhoto(state, context, "photo", message.photo);
    mediaLabels.push("Photo");
  }
  if (message.paid_media !== undefined) {
    const paidParts = message.paid_media.paid_media.map((media) => {
      switch (media.type) {
        case "live_photo":
          addLivePhoto(state, context, media.live_photo, "paid live photo");
          return "live photo";
        case "photo":
          addPhoto(state, context, "paid photo", media.photo);
          return "photo";
        case "video":
          addStandardFile(state, context, "paid video", media.video, "paid-video.mp4");
          return "video";
        case "preview":
          return "locked preview";
        default:
          return "media";
      }
    });
    lines.push(`Paid media (${message.paid_media.star_count} Stars): ${paidParts.join(", ")}`);
  }
  if (message.sticker !== undefined) {
    addSticker(state, context, message.sticker, "sticker");
    lines.push(stickerSummary(message.sticker));
  }
  if (message.story !== undefined) {
    lines.push(`Forwarded story #${message.story.id} from ${chatName(message.story.chat)}`);
  }
  if (message.video !== undefined) {
    addStandardFile(state, context, "video", message.video, "video.mp4");
    mediaLabels.push("Video");
  }
  if (message.video_note !== undefined) {
    addStandardFile(
      state,
      context,
      "video note",
      message.video_note,
      "video-note.mp4",
      "video/mp4",
    );
    mediaLabels.push("Video note");
  }
  if (message.voice !== undefined) {
    addStandardFile(state, context, "voice message", message.voice, "voice.ogg", "audio/ogg", true);
    mediaLabels.push("Voice message");
  }
  if (message.contact !== undefined) lines.push(contactSummary(message.contact));
  if (message.dice !== undefined) lines.push(`Dice: ${message.dice.emoji} = ${message.dice.value}`);
  if (message.location !== undefined && message.venue === undefined) {
    lines.push(locationSummary(message.location));
  }
  if (message.venue !== undefined) lines.push(venueSummary(message.venue));
  if (message.poll !== undefined) lines.push(...pollSummary(message.poll, state, context));
  if (message.checklist !== undefined) lines.push(...checklistSummary(message.checklist));
  if (message.game !== undefined) lines.push(...gameSummary(message.game, state, context));

  if (!hasWords && mediaLabels.length > 0) lines.push(`[${mediaLabels.join(", ")}]`);
  return cleanLines(lines);
}

function pollSummary(
  poll: NonNullable<Message["poll"]>,
  state: NormalizeState,
  context: ContextKind,
): string[] {
  const status = poll.is_closed ? "closed" : "open";
  const lines = [
    `Poll: ${poll.question} (${poll.type}, ${status}, ${poll.total_voter_count} votes)`,
  ];
  const correct = new Set(poll.correct_option_ids ?? []);
  for (const [index, option] of poll.options.entries()) {
    const mark = correct.has(index) ? " [correct]" : "";
    lines.push(`- ${option.text} — ${option.voter_count} votes${mark}`);
    if (option.media !== undefined) {
      lines.push(...indent(describePollMedia(option.media, state, context, `option ${index + 1}`)));
    }
  }
  if (poll.description) lines.push(`Description: ${poll.description}`);
  if (poll.media !== undefined) {
    lines.push(...describePollMedia(poll.media, state, context, "poll"));
  }
  if (poll.explanation) lines.push(`Explanation: ${poll.explanation}`);
  if (poll.explanation_media !== undefined) {
    lines.push(...describePollMedia(poll.explanation_media, state, context, "explanation"));
  }
  return lines;
}

function describePollMedia(
  media: NonNullable<NonNullable<Message["poll"]>["media"]>,
  state: NormalizeState,
  context: ContextKind,
  label: string,
): string[] {
  if (media.animation !== undefined) {
    addStandardFile(
      state,
      context,
      `${label} animation`,
      media.animation,
      animationName(media.animation),
    );
    return [`${titleCase(label)} media: animation`];
  }
  if (media.audio !== undefined) {
    addStandardFile(state, context, `${label} audio`, media.audio, audioName(media.audio));
    return [`${titleCase(label)} media: audio`];
  }
  if (media.document !== undefined) {
    addStandardFile(state, context, `${label} document`, media.document, "poll-document.bin");
    return [`${titleCase(label)} media: document`];
  }
  if (media.live_photo !== undefined) {
    addLivePhoto(state, context, media.live_photo, `${label} live photo`);
    return [`${titleCase(label)} media: live photo`];
  }
  if (media.photo !== undefined) {
    addPhoto(state, context, `${label} photo`, media.photo);
    return [`${titleCase(label)} media: photo`];
  }
  if (media.sticker !== undefined) {
    addSticker(state, context, media.sticker, `${label} sticker`);
    return [`${titleCase(label)} media: ${stickerSummary(media.sticker)}`];
  }
  if (media.video !== undefined) {
    addStandardFile(state, context, `${label} video`, media.video, "poll-video.mp4");
    return [`${titleCase(label)} media: video`];
  }
  if (media.venue !== undefined) return [`${titleCase(label)} media: ${venueSummary(media.venue)}`];
  if (media.location !== undefined) {
    return [`${titleCase(label)} media: ${locationSummary(media.location)}`];
  }
  if (media.link !== undefined) return [`${titleCase(label)} link: ${media.link.url}`];
  return [];
}

function checklistSummary(checklist: NonNullable<Message["checklist"]>): string[] {
  const lines = [`Checklist: ${checklist.title}`];
  for (const task of checklist.tasks) {
    const completed =
      task.completed_by_user !== undefined ||
      task.completed_by_chat !== undefined ||
      (task.completion_date !== undefined && task.completion_date !== 0);
    const actor = task.completed_by_user
      ? ` by ${userName(task.completed_by_user)}`
      : task.completed_by_chat
        ? ` by ${chatName(task.completed_by_chat)}`
        : "";
    lines.push(`- [${completed ? "x" : " "}] ${task.text}${actor}`);
  }
  return lines;
}

function gameSummary(
  game: NonNullable<Message["game"]>,
  state: NormalizeState,
  context: ContextKind,
): string[] {
  addPhoto(state, context, "game photo", game.photo);
  if (game.animation !== undefined) {
    addStandardFile(
      state,
      context,
      "game animation",
      game.animation,
      animationName(game.animation),
    );
  }
  return cleanLines([`Game: ${game.title} — ${game.description}`, game.text?.trim() || undefined]);
}

function describeRichBlocks(
  blocks: readonly RichBlock[],
  state: NormalizeState,
  context: ContextKind,
): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "footer":
      case "thinking":
        lines.push(flattenRichText(block.text));
        break;
      case "heading":
        lines.push(`${"#".repeat(block.size)} ${flattenRichText(block.text)}`);
        break;
      case "pre":
        lines.push(`\`\`\`${block.language ?? ""}\n${flattenRichText(block.text)}\n\`\`\``);
        break;
      case "divider":
        lines.push("---");
        break;
      case "mathematical_expression":
        lines.push(`$${block.expression}$`);
        break;
      case "anchor":
        break;
      case "list":
        for (const item of block.items) {
          const mark = item.has_checkbox ? `[${item.is_checked ? "x" : " "}] ` : "";
          const body = describeRichBlocks(item.blocks, state, context).join(" ");
          lines.push(`- ${mark}${body}`);
        }
        break;
      case "blockquote":
        lines.push(...describeRichBlocks(block.blocks, state, context).map((line) => `> ${line}`));
        if (block.credit !== undefined) lines.push(`> — ${flattenRichText(block.credit)}`);
        break;
      case "pullquote":
        lines.push(`> ${flattenRichText(block.text)}`);
        if (block.credit !== undefined) lines.push(`> — ${flattenRichText(block.credit)}`);
        break;
      case "collage":
      case "slideshow":
        lines.push(...describeRichBlocks(block.blocks, state, context));
        lines.push(richCaption(block.caption));
        break;
      case "table":
        for (const row of block.cells) {
          lines.push(row.map((cell) => (cell.text ? flattenRichText(cell.text) : "")).join(" | "));
        }
        if (block.caption !== undefined) lines.push(flattenRichText(block.caption));
        break;
      case "details":
        lines.push(`Details: ${flattenRichText(block.summary)}`);
        lines.push(...indent(describeRichBlocks(block.blocks, state, context)));
        break;
      case "map":
        lines.push(locationSummary(block.location));
        lines.push(richCaption(block.caption));
        break;
      case "animation":
        addStandardFile(
          state,
          context,
          "rich-message animation",
          block.animation,
          animationName(block.animation),
        );
        lines.push(richCaption(block.caption) || "[Animation]");
        break;
      case "audio":
        addStandardFile(state, context, "rich-message audio", block.audio, audioName(block.audio));
        lines.push(richCaption(block.caption) || "[Audio]");
        break;
      case "photo":
        addPhoto(state, context, "rich-message photo", block.photo);
        lines.push(richCaption(block.caption) || "[Photo]");
        break;
      case "video":
        addStandardFile(state, context, "rich-message video", block.video, "rich-video.mp4");
        lines.push(richCaption(block.caption) || "[Video]");
        break;
      case "voice_note":
        addStandardFile(
          state,
          context,
          "rich-message voice note",
          block.voice_note,
          "rich-voice.ogg",
        );
        lines.push(richCaption(block.caption) || "[Voice message]");
        break;
    }
  }
  return cleanLines(lines);
}

function flattenRichText(text: RichText): string {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.map(flattenRichText).join("");
  if (text.type === "custom_emoji") return text.alternative_text;
  if (text.type === "mathematical_expression") return `$${text.expression}$`;
  if (text.type === "anchor") return "";
  const value = flattenRichText(text.text);
  return text.type === "url" && !value.includes(text.url) ? `${value} (${text.url})` : value;
}

function richCaption(caption: RichBlockCaption | undefined): string {
  if (caption === undefined) return "";
  const credit = caption.credit === undefined ? "" : ` — ${flattenRichText(caption.credit)}`;
  return `${flattenRichText(caption.text)}${credit}`;
}

function contactSummary(contact: NonNullable<Message["contact"]>): string {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
  const details = [`Contact: ${name} — ${contact.phone_number}`];
  if (contact.user_id !== undefined) details.push(`Telegram user #${contact.user_id}`);
  if (contact.vcard) details.push(`vCard: ${clip(contact.vcard.replaceAll("\n", " "), 500)}`);
  return details.join("; ");
}

function locationSummary(location: NonNullable<Message["location"]>): string {
  const details = [`Location: ${location.latitude}, ${location.longitude}`];
  if (location.horizontal_accuracy !== undefined) {
    details.push(`accuracy ${location.horizontal_accuracy} m`);
  }
  if (location.live_period !== undefined) details.push(`live ${location.live_period} s`);
  if (location.heading !== undefined) details.push(`heading ${location.heading}°`);
  if (location.proximity_alert_radius !== undefined) {
    details.push(`proximity ${location.proximity_alert_radius} m`);
  }
  return details.join("; ");
}

function venueSummary(venue: NonNullable<Message["venue"]>): string {
  const placeIds = [
    venue.foursquare_id ? `Foursquare ${venue.foursquare_id}` : undefined,
    venue.google_place_id ? `Google ${venue.google_place_id}` : undefined,
  ].filter(Boolean);
  const suffix = placeIds.length === 0 ? "" : `; ${placeIds.join(", ")}`;
  return `Venue: ${venue.title} — ${venue.address}; ${venue.location.latitude}, ${venue.location.longitude}${suffix}`;
}

function stickerSummary(sticker: NonNullable<Message["sticker"]>): string {
  const format = sticker.is_video ? "video" : sticker.is_animated ? "animated" : "static";
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : "";
  const set = sticker.set_name ? `, set ${sticker.set_name}` : "";
  return `Sticker${emoji} (${format}${set})`;
}

function addSticker(
  state: NormalizeState,
  context: ContextKind,
  sticker: NonNullable<Message["sticker"]>,
  kind: string,
): void {
  const extension = sticker.is_video ? ".webm" : sticker.is_animated ? ".tgs" : ".webp";
  const mime = sticker.is_video
    ? "video/webm"
    : sticker.is_animated
      ? "application/x-tgsticker"
      : "image/webp";
  addFile(state, {
    fileId: sticker.file_id,
    uniqueId: sticker.file_unique_id,
    description: fileDescription(context, kind),
    suggestedName: `sticker${extension}`,
    mimeType: mime,
    size: sticker.file_size,
    nativeImage: !sticker.is_video && !sticker.is_animated,
  });
}

function addLivePhoto(
  state: NormalizeState,
  context: ContextKind,
  livePhoto: NonNullable<Message["live_photo"]>,
  kind: string,
): void {
  if (livePhoto.photo !== undefined) addPhoto(state, context, `${kind} still`, livePhoto.photo);
  addStandardFile(state, context, `${kind} video`, livePhoto, "live-photo.mp4", "video/mp4");
}

function addPhoto(
  state: NormalizeState,
  context: ContextKind,
  kind: string,
  photos: readonly PhotoSize[],
): void {
  const photo = largestPhoto(photos);
  if (photo === undefined) return;
  addFile(state, {
    fileId: photo.file_id,
    uniqueId: photo.file_unique_id,
    description: fileDescription(context, kind),
    suggestedName: "photo.jpg",
    mimeType: "image/jpeg",
    size: photo.file_size,
    nativeImage: true,
  });
}

function addStandardFile(
  state: NormalizeState,
  context: ContextKind,
  kind: string,
  file: FileLike,
  fallbackName: string,
  fallbackMime?: string,
  voiceMessage = false,
): void {
  const mimeType = file.mime_type ?? fallbackMime;
  const suggestedName = safeName(file.file_name, fallbackName);
  addFile(state, {
    fileId: file.file_id,
    uniqueId: file.file_unique_id,
    description: fileDescription(context, kind),
    suggestedName,
    mimeType,
    size: file.file_size,
    nativeImage: isNativeImage(mimeType, suggestedName),
    voiceMessage,
  });
}

function addFile(
  state: NormalizeState,
  input: {
    readonly fileId: string;
    readonly uniqueId: string;
    readonly description: string;
    readonly suggestedName: string;
    readonly mimeType?: string | undefined;
    readonly size?: number | undefined;
    readonly nativeImage: boolean;
    readonly voiceMessage?: boolean | undefined;
  },
): void {
  if (state.fileIds.has(input.uniqueId)) return;
  state.fileIds.add(input.uniqueId);
  state.files.push({
    fileId: input.fileId,
    uniqueId: input.uniqueId,
    description: input.description,
    suggestedName: safeName(input.suggestedName, "telegram-file"),
    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    ...(input.size === undefined ? {} : { size: input.size }),
    nativeImage: input.nativeImage,
    ...(input.voiceMessage === true ? { voiceMessage: true } : {}),
  });
}

function scanAccessibleFiles(
  value: unknown,
  state: NormalizeState,
  context: ContextKind,
  hint: string,
): void {
  if (value === null || typeof value !== "object") return;
  if (state.scanned.has(value)) return;
  state.scanned.add(value);

  if (Array.isArray(value)) {
    if (isPhotoArray(value)) {
      addPhoto(state, context, humanize(hint), value);
      return;
    }
    for (const item of value) scanAccessibleFiles(item, state, context, hint);
    return;
  }

  const record = value as Record<string, unknown>;
  if (isFileLike(record)) {
    addGenericFile(state, context, hint, record);
    for (const [key, child] of Object.entries(record)) {
      if (key === "photo" || key === "premium_animation") {
        scanAccessibleFiles(child, state, context, key);
      }
    }
    return;
  }

  for (const [key, child] of Object.entries(record)) {
    if (FILE_SCAN_SKIP_KEYS.has(key)) continue;
    if (key === "document" && record.animation !== undefined) continue;
    if (key === "photo" && record.live_photo !== undefined) continue;
    scanAccessibleFiles(child, state, context, key);
  }
}

function addGenericFile(
  state: NormalizeState,
  context: ContextKind,
  hint: string,
  file: FileLike & Record<string, unknown>,
): void {
  const isSticker = typeof file.is_animated === "boolean" && typeof file.is_video === "boolean";
  const isStaticSticker = isSticker && file.is_animated === false && file.is_video === false;
  const isPhoto = hint.toLowerCase().includes("photo") && !hint.toLowerCase().includes("live");
  const mimeType =
    file.mime_type ?? (isStaticSticker ? "image/webp" : isPhoto ? "image/jpeg" : undefined);
  const extension = isSticker
    ? file.is_video
      ? ".webm"
      : file.is_animated
        ? ".tgs"
        : ".webp"
    : extensionForMime(mimeType) || ".bin";
  const suggestedName = safeName(file.file_name, `${slug(hint)}${extension}`);
  addFile(state, {
    fileId: file.file_id,
    uniqueId: file.file_unique_id,
    description: fileDescription(context, humanize(hint)),
    suggestedName,
    mimeType,
    size: file.file_size,
    nativeImage: isStaticSticker || isPhoto || isNativeImage(mimeType, suggestedName),
  });
}

function genericMessageFallback(message: Message): string[] {
  const lines: string[] = [];
  let remaining = 1_200;
  const record = message as unknown as Record<string, unknown>;
  if (record.passport_data !== undefined) {
    const line = "Telegram Passport data received (redacted).";
    lines.push(line);
    remaining -= line.length;
  }
  for (const [key, value] of Object.entries(record)) {
    if (remaining <= 0 || key === "passport_data" || HANDLED_MESSAGE_KEYS.has(key)) continue;
    const label = titleCase(humanize(key));
    const detail = value === true ? "" : `: ${compactValue(value, 0)}`;
    const line = clip(`${label}${detail}.`, Math.min(400, remaining));
    lines.push(line);
    remaining -= line.length;
  }
  return lines;
}

function compactValue(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return clip(value, 240);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return String(value);
  if (isFileLike(value as Record<string, unknown>)) return "[file]";
  if (Array.isArray(value)) {
    const shown = value.slice(0, 6).map((item) => compactValue(item, depth + 1));
    return `[${shown.join(", ")}${value.length > shown.length ? ", …" : ""}]`;
  }
  if (depth >= 2) return "{…}";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "passport_data" && key !== "file_id" && key !== "file_unique_id")
    .slice(0, 8)
    .map(([key, child]) => `${humanize(key)}=${compactValue(child, depth + 1)}`);
  return `{${entries.join(", ")}}`;
}

function describeOrigin(origin: MessageOrigin): string {
  const date = new Date(origin.date * 1_000).toISOString();
  switch (origin.type) {
    case "user":
      return `${userName(origin.sender_user)} on ${date}`;
    case "hidden_user":
      return `${origin.sender_user_name} (hidden user) on ${date}`;
    case "chat":
      return `${chatName(origin.sender_chat)}${origin.author_signature ? ` (${origin.author_signature})` : ""} on ${date}`;
    case "channel":
      return `${chatName(origin.chat)} message #${origin.message_id}${origin.author_signature ? ` (${origin.author_signature})` : ""} on ${date}`;
  }
}

function messageActor(message: Message): string {
  if (message.from !== undefined) return userName(message.from);
  if (message.sender_chat !== undefined) return chatName(message.sender_chat);
  return "the earlier Telegram message";
}

function userName(user: {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}): string {
  const fullName =
    [user.first_name, user.last_name].filter(Boolean).join(" ") || `user #${user.id}`;
  return user.username ? `${fullName} (@${user.username})` : fullName;
}

function chatName(chat: {
  id: number;
  title?: string | undefined;
  username?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
}): string {
  const name = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  const fallback = name || chat.username || `chat #${chat.id}`;
  return chat.username && fallback !== chat.username ? `${fallback} (@${chat.username})` : fallback;
}

function largestPhoto(photos: readonly PhotoSize[]): PhotoSize | undefined {
  return photos.reduce<PhotoSize | undefined>((largest, photo) => {
    if (largest === undefined) return photo;
    const area = photo.width * photo.height;
    const largestArea = largest.width * largest.height;
    if (area !== largestArea) return area > largestArea ? photo : largest;
    return (photo.file_size ?? 0) > (largest.file_size ?? 0) ? photo : largest;
  }, undefined);
}

function isPhotoArray(value: readonly unknown[]): value is PhotoSize[] {
  return (
    value.length > 0 &&
    value.every((item) => {
      if (item === null || typeof item !== "object") return false;
      const photo = item as Record<string, unknown>;
      return (
        isFileLike(photo) && typeof photo.width === "number" && typeof photo.height === "number"
      );
    })
  );
}

function isFileLike(value: Record<string, unknown>): value is FileLike & Record<string, unknown> {
  return typeof value.file_id === "string" && typeof value.file_unique_id === "string";
}

function fileDescription(context: ContextKind, kind: string): string {
  const prefix = {
    current: "Telegram",
    reply: "Replied-to Telegram",
    external: "External-reply Telegram",
    reference: "Referenced Telegram",
  }[context];
  return `${prefix} ${kind}`;
}

function animationName(animation: NonNullable<Message["animation"]>): string {
  return animation.mime_type?.toLowerCase().startsWith("image/gif")
    ? "animation.gif"
    : "animation.mp4";
}

function audioName(audio: NonNullable<Message["audio"]>): string {
  if (audio.file_name) return audio.file_name;
  return `${audio.title ?? "audio"}${extensionForMime(audio.mime_type) || ".mp3"}`;
}

function isNativeImage(mimeType: string | undefined, name: string): boolean {
  const normalizedMime = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedMime !== undefined) return NATIVE_IMAGE_MIMES.has(normalizedMime);
  return NATIVE_IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

function extensionForMime(mimeType: string | undefined): string {
  switch (mimeType?.split(";", 1)[0]?.trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

function safeName(raw: string | undefined, fallback: string): string {
  const base = basename((raw ?? fallback).replaceAll("\\", "/"));
  const cleaned = [...base]
    .map((character) => (character < " " || character === "\u007f" ? "_" : character))
    .join("")
    .trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? fallback : cleaned.slice(0, 180);
}

function cleanLines(lines: readonly (string | undefined)[]): string[] {
  return lines.filter((line): line is string => line !== undefined && line.trim().length > 0);
}

function indent(lines: readonly string[]): string[] {
  return lines.map((line) => `  ${line}`);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function slug(value: string): string {
  const normalized = humanize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return normalized.replace(/^-|-$/g, "") || "telegram-file";
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;
}
