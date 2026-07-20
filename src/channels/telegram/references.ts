import { z } from "zod";
import type { ProviderReference } from "../../core/channel.js";
import type { TelegramDestination, TelegramReplyRoute } from "./route.js";

const telegramDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat") }),
  z.object({ kind: z.literal("topic"), messageThreadId: z.number().int() }),
  z.object({
    kind: z.literal("directMessagesTopic"),
    directMessagesTopicId: z.number().int(),
  }),
  z.object({ kind: z.literal("genericThread"), replyToMessageId: z.number().int() }),
]);

const targetSchema = z.object({
  version: z.literal(1),
  chatId: z.number().int().safe(),
  chatType: z.enum(["private", "group", "supergroup", "channel"]),
  destination: telegramDestinationSchema,
});

const messageSchema = z.object({
  version: z.literal(1),
  chatId: z.number().int().safe(),
  messageId: z.number().int(),
});

export interface TelegramDeliveryTarget {
  readonly chatId: number;
  readonly chatType: "private" | "group" | "supergroup" | "channel";
  readonly destination: TelegramDestination;
}

export function telegramDeliveryTarget(
  chatId: number,
  chatType: TelegramDeliveryTarget["chatType"],
  route: TelegramReplyRoute,
): ProviderReference {
  if (route.visibility.kind !== "normal") {
    throw new Error("Ephemeral Telegram messages cannot be proactive delivery targets");
  }
  return {
    provider: "telegram",
    resource: "destination",
    id: encodeReference({
      version: 1,
      chatId,
      chatType,
      destination: route.destination,
    }),
  };
}

export function parseTelegramDeliveryTarget(reference: ProviderReference): TelegramDeliveryTarget {
  if (reference.provider !== "telegram" || reference.resource !== "destination") {
    throw new Error("The delivery target does not belong to Telegram");
  }
  const parsed = targetSchema.parse(decodeReference(reference.id));
  return {
    chatId: parsed.chatId,
    chatType: parsed.chatType,
    destination: parsed.destination,
  };
}

export function telegramMessageReference(chatId: number, messageId: number): ProviderReference {
  return {
    provider: "telegram",
    resource: "message",
    id: encodeReference({ version: 1, chatId, messageId }),
  };
}

export function parseTelegramMessageReference(
  reference: ProviderReference,
): Readonly<{ chatId: number; messageId: number }> {
  if (reference.provider !== "telegram" || reference.resource !== "message") {
    throw new Error("The message reference does not belong to Telegram");
  }
  const parsed = messageSchema.parse(decodeReference(reference.id));
  return { chatId: parsed.chatId, messageId: parsed.messageId };
}

function encodeReference(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeReference(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
