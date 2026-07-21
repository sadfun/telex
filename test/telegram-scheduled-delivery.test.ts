import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { TelegramChannel, telegramMenuButton } from "../src/channels/telegram/channel.js";
import {
  parseTelegramDeliveryTarget,
  parseTelegramMessageReference,
  telegramDeliveryTarget,
  telegramMessageReference,
} from "../src/channels/telegram/references.js";
import { decodeCommandCallback, publishTelegramMessage } from "../src/channels/telegram/reply.js";
import type { TelegramReplyRoute } from "../src/channels/telegram/route.js";
import { Logger } from "../src/shared/logger.js";

describe("Telegram scheduled delivery", () => {
  it("pins the settings Mini App to the bot menu", () => {
    expect(telegramMenuButton("https://telex.example/miniapp")).toEqual({
      type: "web_app",
      text: "Settings",
      web_app: { url: "https://telex.example/miniapp" },
    });
  });

  it("restores the commands menu when the Mini App is unavailable", () => {
    expect(telegramMenuButton(undefined)).toEqual({ type: "commands" });
  });

  it("keeps provider routing details inside opaque versioned references", () => {
    const route = topicRoute(19);
    const target = telegramDeliveryTarget(42, "supergroup", route);
    const message = telegramMessageReference(42, 91);

    expect(target).toMatchObject({ provider: "telegram", resource: "destination" });
    expect(parseTelegramDeliveryTarget(target)).toEqual({
      chatId: 42,
      chatType: "supergroup",
      destination: { kind: "topic", messageThreadId: 19 },
    });
    expect(parseTelegramMessageReference(message)).toEqual({ chatId: 42, messageId: 91 });
  });

  it("returns every split message and encodes durable command actions", async () => {
    let nextMessageId = 10;
    const sendMessage = vi.fn(
      async (_chatId: number, _text: string, _options: Record<string, unknown>) => ({
        message_id: nextMessageId++,
      }),
    );
    const runId = "17d08466-a7c6-4410-b8e0-e9a207ef0919";

    const messageIds = await publishTelegramMessage(
      { sendMessage } as unknown as Api,
      42,
      topicRoute(19),
      {
        text: "x".repeat(5_000),
        actions: [{ label: "Continue this run", command: { name: "continue", args: runId } }],
      },
      new Logger("error"),
    );

    expect(messageIds).toEqual([10, 11]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[2]).toEqual({ message_thread_id: 19 });
    const lastOptions = sendMessage.mock.calls[1]?.[2];
    expect(lastOptions).toMatchObject({
      message_thread_id: 19,
      reply_markup: {
        inline_keyboard: [[{ text: "Continue this run", callback_data: `tx:continue:${runId}` }]],
      },
    });
    expect(decodeCommandCallback(`tx:continue:${runId}`)).toEqual({
      name: "continue",
      args: runId,
    });
  });

  it("does not turn an ephemeral route into a public scheduled destination", () => {
    expect(() =>
      telegramDeliveryTarget(42, "private", {
        destination: { kind: "chat" },
        visibility: {
          kind: "ephemeral",
          receiverUserId: 7,
          incomingEphemeralMessageId: 19,
        },
      }),
    ).toThrow("cannot be proactive delivery targets");
  });

  it("re-checks persisted provider principals against the current allowlist", () => {
    const channel = new TelegramChannel(
      "123:test",
      "https://api.telegram.org",
      new Set([7]),
      30,
      "/tmp/telex-test-attachments",
      new Logger("error"),
    );

    expect(channel.isAuthorized({ provider: "telegram", resource: "user", id: "7" })).toBe(true);
    expect(channel.isAuthorized({ provider: "telegram", resource: "user", id: "8" })).toBe(false);
    expect(channel.isAuthorized({ provider: "telegram", resource: "message", id: "7" })).toBe(
      false,
    );
  });
});

function topicRoute(messageThreadId: number): TelegramReplyRoute {
  return {
    destination: { kind: "topic", messageThreadId },
    visibility: { kind: "normal" },
  };
}
