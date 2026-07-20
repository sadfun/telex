import type { Message } from "grammy/types";
import type { InboundCommand } from "../../core/channel.js";

export type TelegramDestination =
  | { readonly kind: "chat" }
  | { readonly kind: "topic"; readonly messageThreadId: number }
  | { readonly kind: "directMessagesTopic"; readonly directMessagesTopicId: number }
  | { readonly kind: "genericThread"; readonly replyToMessageId: number };

export type TelegramVisibility =
  | { readonly kind: "normal" }
  | {
      readonly kind: "ephemeral";
      readonly receiverUserId: number;
      readonly incomingEphemeralMessageId: number;
    };

export interface TelegramReplyRoute {
  readonly destination: TelegramDestination;
  readonly visibility: TelegramVisibility;
}

export interface TelegramIncomingRoute {
  readonly reply: TelegramReplyRoute;
  readonly conversationSuffix: string;
}

export type TelegramCommandMatch =
  | { readonly kind: "command"; readonly command: InboundCommand }
  | { readonly kind: "otherBot" }
  | { readonly kind: "none" };

export function routeTelegramMessage(
  message: Message,
  senderUserId: number,
): TelegramIncomingRoute | undefined {
  const visibility: TelegramVisibility =
    message.ephemeral_message_id === undefined
      ? { kind: "normal" }
      : {
          kind: "ephemeral",
          receiverUserId: senderUserId,
          incomingEphemeralMessageId: message.ephemeral_message_id,
        };
  const directMessagesTopicId = message.direct_messages_topic?.topic_id;
  if (directMessagesTopicId !== undefined) {
    return {
      conversationSuffix: `direct:${directMessagesTopicId}`,
      reply: {
        destination: { kind: "directMessagesTopic", directMessagesTopicId },
        visibility,
      },
    };
  }
  if (message.chat.is_direct_messages === true) return undefined;

  const messageThreadId = message.message_thread_id;
  if (message.is_topic_message === true && messageThreadId !== undefined) {
    return {
      // Preserve the existing durable key for ordinary forum and private-chat topics.
      conversationSuffix: String(messageThreadId),
      reply: {
        destination: { kind: "topic", messageThreadId },
        visibility,
      },
    };
  }
  if (messageThreadId !== undefined) {
    return {
      // A generic thread ID identifies its root message. It is not a forum topic parameter.
      conversationSuffix: String(messageThreadId),
      reply: {
        destination: { kind: "genericThread", replyToMessageId: messageThreadId },
        visibility,
      },
    };
  }
  return {
    conversationSuffix: "0",
    reply: { destination: { kind: "chat" }, visibility },
  };
}

export function matchTelegramCommand(
  message: Message,
  botUsername: string | undefined,
): TelegramCommandMatch {
  const text = message.text;
  if (text === undefined) return { kind: "none" };

  const commandEntity = message.entities?.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (commandEntity !== undefined) {
    return matchCommandToken(
      text.slice(0, commandEntity.length),
      text.slice(commandEntity.length).trimStart(),
      botUsername,
    );
  }
  if (message.entities !== undefined) return { kind: "none" };

  // Telegram normally supplies a bot_command entity. The fallback keeps synthetic updates and
  // compatible Bot API implementations working without parsing captions as commands.
  const fallback = /^(\/[a-z][a-z0-9_]*(?:@[a-z0-9_]+)?)(?:[ \t]+([^\r\n]*))?$/i.exec(text);
  const token = fallback?.[1];
  if (token === undefined) return { kind: "none" };
  return matchCommandToken(token, fallback?.[2]?.trimStart() ?? "", botUsername);
}

function matchCommandToken(
  token: string,
  args: string,
  botUsername: string | undefined,
): TelegramCommandMatch {
  const parsed = /^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?$/i.exec(token);
  const name = parsed?.[1];
  if (name === undefined) return { kind: "none" };
  const target = parsed?.[2];
  if (target !== undefined && target.toLowerCase() !== botUsername?.toLowerCase()) {
    return { kind: "otherBot" };
  }
  return {
    kind: "command",
    command: { name: name.toLowerCase(), args },
  };
}
