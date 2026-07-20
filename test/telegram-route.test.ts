import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { telegramBotCommands } from "../src/channels/telegram/channel.js";
import { matchTelegramCommand, routeTelegramMessage } from "../src/channels/telegram/route.js";

describe("telegramBotCommands", () => {
  it("registers /start without claiming long-running command replies are ephemeral", () => {
    expect(telegramBotCommands[0]).toMatchObject({ command: "start" });
    expect(telegramBotCommands.filter((command) => command.command === "start")).toHaveLength(1);
    expect(telegramBotCommands.map((command) => command.command)).toEqual(
      expect.arrayContaining(["reload", "restart"]),
    );
    expect(telegramBotCommands.every((command) => !("is_ephemeral" in command))).toBe(true);
  });
});

describe("routeTelegramMessage", () => {
  it("routes true forum topics with the existing conversation suffix", () => {
    const route = routeTelegramMessage(
      message({ message_thread_id: 17, is_topic_message: true }),
      42,
    );

    expect(route).toEqual({
      conversationSuffix: "17",
      reply: {
        destination: { kind: "topic", messageThreadId: 17 },
        visibility: { kind: "normal" },
      },
    });
  });

  it("keeps a generic message thread distinct without treating it as a forum topic", () => {
    const route = routeTelegramMessage(message({ message_thread_id: 55 }), 42);

    expect(route).toEqual({
      conversationSuffix: "55",
      reply: {
        destination: { kind: "genericThread", replyToMessageId: 55 },
        visibility: { kind: "normal" },
      },
    });
  });

  it("gives channel direct-message topics precedence over thread-looking fields", () => {
    const route = routeTelegramMessage(
      message({
        message_thread_id: 17,
        is_topic_message: true,
        chat: {
          id: -100,
          type: "supergroup",
          title: "Channel messages",
          is_direct_messages: true,
        },
        direct_messages_topic: {
          topic_id: 91,
          user: { id: 42, is_bot: false, first_name: "Ada" },
        },
      }),
      42,
    );

    expect(route).toMatchObject({
      conversationSuffix: "direct:91",
      reply: { destination: { kind: "directMessagesTopic", directMessagesTopicId: 91 } },
    });
  });

  it("does not send into a channel direct-message chat when its required topic is absent", () => {
    const route = routeTelegramMessage(
      message({
        chat: {
          id: -100,
          type: "supergroup",
          title: "Channel messages",
          is_direct_messages: true,
        },
      }),
      42,
    );

    expect(route).toBeUndefined();
  });

  it("keeps ephemeral visibility separate and targets the sender", () => {
    const route = routeTelegramMessage(
      message({
        message_id: 0,
        message_thread_id: 17,
        is_topic_message: true,
        ephemeral_message_id: 700,
      }),
      42,
    );

    expect(route?.reply).toEqual({
      destination: { kind: "topic", messageThreadId: 17 },
      visibility: {
        kind: "ephemeral",
        receiverUserId: 42,
        incomingEphemeralMessageId: 700,
      },
    });
  });
});

describe("matchTelegramCommand", () => {
  it("extracts a targeted command and its arguments from the raw entity", () => {
    const text = "/start@Telex_Bot setup-token";
    const match = matchTelegramCommand(
      message({
        text,
        entities: [{ type: "bot_command", offset: 0, length: "/start@Telex_Bot".length }],
      }),
      "telex_bot",
    );

    expect(match).toEqual({
      kind: "command",
      command: { name: "start", args: "setup-token" },
    });
  });

  it("ignores a command addressed to another bot", () => {
    const text = "/start@other_bot";
    expect(
      matchTelegramCommand(
        message({
          text,
          entities: [{ type: "bot_command", offset: 0, length: text.length }],
        }),
        "telex_bot",
      ),
    ).toEqual({ kind: "otherBot" });
  });

  it("does not interpret a media caption as a command", () => {
    expect(matchTelegramCommand(message({ caption: "/start" }), "telex_bot")).toEqual({
      kind: "none",
    });
  });

  it("supports entity-free Bot API-compatible command fixtures", () => {
    expect(matchTelegramCommand(message({ text: "/start payload" }), "telex_bot")).toEqual({
      kind: "command",
      command: { name: "start", args: "payload" },
    });
  });
});

function message(content: Partial<Message>): Message {
  return {
    message_id: 123,
    date: 1_700_000_100,
    chat: { id: -1, type: "supergroup", title: "Test" },
    ...content,
  } as Message;
}
