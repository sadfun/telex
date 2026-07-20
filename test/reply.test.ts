import type { Api } from "grammy";
import type { Chat, InputRichMessageWithoutUpload } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatThinkingBlock,
  splitTelegramText,
  TelegramGuestResponder,
  TelegramResponder,
} from "../src/channels/telegram/reply.js";
import type { TelegramReplyRoute } from "../src/channels/telegram/route.js";
import { Logger } from "../src/shared/logger.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("splitTelegramText", () => {
  it("keeps short messages intact", () => {
    expect(splitTelegramText("hello", 10)).toEqual(["hello"]);
  });

  it("prefers a nearby newline without losing content", () => {
    const source = "123456\n7890abcdef";
    const chunks = splitTelegramText(source, 10);
    expect(chunks).toEqual(["123456", "7890abcdef"]);
    expect(chunks.join("\n")).toBe(source);
  });

  it("hard-splits long lines", () => {
    expect(splitTelegramText("abcdefghijk", 4)).toEqual(["abcd", "efgh", "ijk"]);
  });
});

describe("formatThinkingBlock", () => {
  it("shows the latest actions as a compact tree", () => {
    expect(
      formatThinkingBlock({
        summary: "Planning granular approval_policy support and validation",
        message: "Inspecting the configuration paths.",
        actions: [
          { label: "Listed files" },
          { label: "Searched approval_policy" },
          { label: "Created   config-service.ts   +840 −0" },
          { label: "Edited    config-service.ts" },
          { label: "Read      copy-assets.ts" },
          { label: "Ran       npx tsc -p tsconfig.json --noEmit   1s" },
        ],
        plan: [],
      }),
    ).toBe(`▌ Planning granular approval_policy support and validation
├ <2 more actions>
├ Created config-service.ts +840 −0
├ Edited config-service.ts
├ Read copy-assets.ts
└ Ran npx tsc -p tsconfig.json --noEmit 1s`);
  });

  it("prioritizes multi-step plan progress over the action tree", () => {
    expect(
      formatThinkingBlock({
        summary: "Updating the Telegram renderer",
        message: "The event stream now carries structured progress.",
        actions: [{ label: "Edited reply.ts" }],
        plan: [
          { step: "Inspect the existing stream", status: "completed" },
          { step: "Model structured activity", status: "completed" },
          { step: "Render richer progress", status: "inProgress" },
          { step: "Run checks", status: "pending" },
        ],
      }),
    ).toBe(`✓ Inspect the existing stream
✓ Model structured activity

→ Render richer progress (Updating the Telegram renderer)
The event stream now carries structured progress.

○ Run checks`);
  });

  it("keeps Telegram thinking text within its limit", () => {
    const result = formatThinkingBlock({ summary: "x".repeat(1_000), actions: [], plan: [] }, 80);
    expect(result).toHaveLength(80);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("Telegram reply routing", () => {
  it.each([
    ["forum topic", topicRoute(17), { message_thread_id: 17 }],
    ["channel direct-message topic", directRoute(91), { direct_messages_topic_id: 91 }],
    ["generic thread", genericThreadRoute(55), { reply_parameters: { message_id: 55 } }],
  ] as const)("sends text to the correct %s destination", async (_name, route, expected) => {
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const { responder } = createResponder({ sendMessage }, route);

    await responder.sendText("hello");

    expect(sendMessage).toHaveBeenCalledWith(42, "hello", expected);
  });

  it("answers a cached ephemeral command privately, then edits the private response", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 0, ephemeral_message_id: 701 }));
    const editEphemeralMessageText = vi.fn(async () => true);
    const { responder } = createResponder(
      { sendMessage, editEphemeralMessageText },
      ephemeralTopicRoute(17, 42, 700),
    );

    await responder.sendText("Checking…");
    await responder.sendText("Done.");

    expect(sendMessage).toHaveBeenCalledWith(42, "Checking…", {
      message_thread_id: 17,
      receiver_user_id: 42,
      reply_parameters: { ephemeral_message_id: 700 },
    });
    expect(editEphemeralMessageText).toHaveBeenCalledWith(42, 42, 701, "Done.", {});
  });

  it("does not publish draft or activity calls for ephemeral streams", async () => {
    const sendRichMessageDraft = vi.fn(async () => true);
    const sendMessageDraft = vi.fn(async () => true);
    const sendChatAction = vi.fn(async () => true);
    const sendRichMessage = vi.fn(async () => ({ message_id: 1 }));
    const sendMessage = vi.fn(async () => ({ message_id: 0, ephemeral_message_id: 701 }));
    const sendDocument = uploadMock(2);
    const route = ephemeralTopicRoute(17, 42, 700);
    const { responder } = createResponder(
      {
        sendRichMessageDraft,
        sendMessageDraft,
        sendChatAction,
        sendRichMessage,
        sendMessage,
        sendDocument,
      },
      route,
    );
    const stream = responder.createStream();

    await stream.start();
    await stream.complete("Done.", [attachment("/workspace/report.pdf")]);

    expect(sendRichMessageDraft).not.toHaveBeenCalled();
    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(sendChatAction).not.toHaveBeenCalled();
    expect(sendRichMessage).not.toHaveBeenCalled();
    const expected = {
      message_thread_id: 17,
      receiver_user_id: 42,
      reply_parameters: { ephemeral_message_id: 700 },
    };
    expect(sendMessage).toHaveBeenCalledWith(42, "Done.", expected);
    expect(sendDocument.mock.calls[0]?.[2]).toEqual(expected);
  });

  it("uses the direct-message topic for final output without unsupported chat activity", async () => {
    const sendChatAction = vi.fn(async () => true);
    const sendRichMessage = vi.fn(async () => ({ message_id: 1 }));
    const directChat = {
      id: 42,
      type: "supergroup",
      title: "Channel messages",
      is_direct_messages: true,
    } satisfies Chat.SupergroupChat;
    const { responder } = createResponder(
      { sendChatAction, sendRichMessage },
      directRoute(91),
      directChat,
    );
    const stream = responder.createStream();

    await stream.start();
    await stream.complete("Done.");

    expect(sendChatAction).not.toHaveBeenCalled();
    expect(sendRichMessage).toHaveBeenCalledWith(
      42,
      { markdown: "Done." },
      { direct_messages_topic_id: 91 },
    );
  });
});

describe("Telegram streaming", () => {
  it("starts voice handling with a transcription thinking block", async () => {
    const drafts: InputRichMessageWithoutUpload[] = [];
    const stream = createStream({
      sendRichMessageDraft: vi.fn(async (_chatId, _draftId, message) => {
        drafts.push(message);
        return true;
      }),
    });

    await stream.start({ summary: "Transcribing…", actions: [], plan: [] });

    expect(drafts[0]).toMatchObject({
      blocks: [{ type: "thinking", text: "▌ Transcribing…" }],
    });
  });

  it("publishes the first response text immediately after the thinking placeholder", async () => {
    const drafts: InputRichMessageWithoutUpload[] = [];
    const stream = createStream({
      sendRichMessageDraft: vi.fn(async (_chatId, _draftId, message) => {
        drafts.push(message);
        return true;
      }),
    });

    await stream.start();
    stream.appendFinal("H");
    await vi.waitFor(() => expect(drafts).toHaveLength(2));

    expect(drafts[1]).toMatchObject({
      blocks: [{ type: "thinking" }, { type: "paragraph", text: "H" }],
    });
  });

  it("coalesces fast deltas into one pending latest snapshot", async () => {
    vi.useFakeTimers();
    let releaseUpdate: (() => void) | undefined;
    const drafts: InputRichMessageWithoutUpload[] = [];
    const sendRichMessageDraft = vi.fn(async (_chatId, _draftId, message) => {
      drafts.push(message);
      if (drafts.length === 2) {
        await new Promise<void>((resolve) => {
          releaseUpdate = resolve;
        });
      }
      return true;
    });
    const stream = createStream({ sendRichMessageDraft });

    await stream.start();
    stream.appendFinal("H");
    await vi.advanceTimersByTimeAsync(0);
    stream.appendFinal("e");
    stream.appendFinal("l");
    stream.appendFinal("l");
    stream.appendFinal("o");
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);

    releaseUpdate?.();
    await vi.advanceTimersByTimeAsync(249);
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(3);
    expect(drafts[2]).toMatchObject({
      blocks: [{ type: "thinking" }, { type: "paragraph", text: "Hello" }],
    });
  });

  it("sends final text before routing files through native Telegram methods", async () => {
    const sendRichMessage = uploadMock(1);
    const sendPhoto = uploadMock(2);
    const sendAnimation = uploadMock(3);
    const sendVideo = uploadMock(4);
    const sendAudio = uploadMock(5);
    const sendDocument = uploadMock(6);
    const stream = createStream(
      { sendRichMessage, sendPhoto, sendAnimation, sendVideo, sendAudio, sendDocument },
      topicRoute(17),
    );

    await stream.complete("Your files:", [
      attachment("/workspace/chart.png"),
      attachment("/workspace/demo.gif"),
      attachment("/workspace/clip.mp4"),
      attachment("/workspace/song.mp3"),
      attachment("/workspace/report.pdf"),
    ]);

    expect(sendRichMessage.mock.invocationCallOrder[0]).toBeLessThan(
      sendPhoto.mock.invocationCallOrder[0] ?? 0,
    );
    for (const send of [sendPhoto, sendAnimation, sendVideo, sendAudio, sendDocument]) {
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[2]).toEqual({ message_thread_id: 17 });
    }
  });

  it("falls back from native media to a fresh document upload", async () => {
    const sendRichMessage = uploadMock(1);
    const sendPhoto = vi.fn(async (_chatId: number, _file: unknown, _params: unknown) => {
      throw new Error("unsupported photo");
    });
    const sendDocument = uploadMock(2);
    const stream = createStream({ sendRichMessage, sendPhoto, sendDocument });

    await stream.complete("", [attachment("/workspace/chart.png")]);

    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendDocument).toHaveBeenCalledOnce();
    expect(sendPhoto.mock.calls[0]?.[1]).not.toBe(sendDocument.mock.calls[0]?.[1]);
  });

  it("reports one failed upload and continues with later files", async () => {
    const sendPhoto = vi.fn(async (_chatId: number, _file: unknown, _params: unknown) => {
      throw new Error("unsupported photo");
    });
    const sendDocument = vi
      .fn(async (_chatId: number, _file: unknown, _params: unknown) => ({ message_id: 1 }))
      .mockRejectedValueOnce(new Error("upload failed"))
      .mockResolvedValueOnce({ message_id: 2 });
    const sendMessage = uploadMock(3);
    const stream = createStream({ sendPhoto, sendDocument, sendMessage });

    await stream.complete("", [
      attachment("/workspace/bad.png"),
      attachment("/workspace/good.pdf"),
    ]);

    expect(sendDocument).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(42, "Could not send bad.png as an attachment.", {});
  });

  it("explains the guest-mode attachment limitation instead of silently omitting files", async () => {
    const answerGuestQuery = vi.fn(async (_queryId: string, _result: unknown) => true);
    const responder = new TelegramGuestResponder(
      { answerGuestQuery } as unknown as Api,
      "guest-query",
    );

    await responder
      .createStream()
      .complete("x".repeat(9_000), [attachment("/workspace/report.pdf")]);

    expect(answerGuestQuery).toHaveBeenCalledOnce();
    expect(answerGuestQuery.mock.calls[0]?.[1]).toMatchObject({
      input_message_content: {
        rich_message: {
          markdown: expect.stringContaining(
            "Generated files can only be attached in a direct chat with this bot: report.pdf",
          ),
        },
      },
    });
  });

  it("preserves a missing-file warning in a long guest response", async () => {
    const answerGuestQuery = vi.fn(async (_queryId: string, _result: unknown) => true);
    const responder = new TelegramGuestResponder(
      { answerGuestQuery } as unknown as Api,
      "guest-query",
    );

    await responder
      .createStream()
      .complete(`Could not attach missing.zip.\n\n${"x".repeat(9_000)}`);

    expect(answerGuestQuery.mock.calls[0]?.[1]).toMatchObject({
      input_message_content: {
        rich_message: { markdown: expect.stringMatching(/^Could not attach missing\.zip\./) },
      },
    });
  });

  it("still uploads attachments when final text delivery fails", async () => {
    const sendRichMessage = vi.fn(async () => {
      throw new Error("rich text failed");
    });
    const sendMessage = vi.fn(async () => {
      throw new Error("plain text failed");
    });
    const sendDocument = uploadMock(2);
    const stream = createStream({ sendRichMessage, sendMessage, sendDocument });

    await stream.complete("Finished.", [attachment("/workspace/report.pdf")]);

    expect(sendDocument).toHaveBeenCalledOnce();
  });
});

function attachment(path: string) {
  return { path, filename: path.slice(path.lastIndexOf("/") + 1) };
}

function uploadMock(messageId: number) {
  return vi.fn(async (_chatId: number, _file: unknown, _params: unknown) => ({
    message_id: messageId,
  }));
}

function createStream(
  apiOverrides: Readonly<Record<string, unknown>>,
  route: TelegramReplyRoute = chatRoute(),
) {
  return createResponder(apiOverrides, route).responder.createStream();
}

function createResponder(
  apiOverrides: Readonly<Record<string, unknown>>,
  route: TelegramReplyRoute = chatRoute(),
  chat: Chat = { id: 42, type: "private", first_name: "Ada" },
) {
  const api = {
    sendRichMessageDraft: vi.fn(async () => true),
    sendMessageDraft: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
    sendRichMessage: vi.fn(async () => ({ message_id: 1 })),
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    ...apiOverrides,
  } as unknown as Api;
  const responder = new TelegramResponder(
    api,
    chat,
    route,
    42,
    async () => "decline",
    new Logger("error"),
  );
  return { api, responder };
}

function chatRoute(): TelegramReplyRoute {
  return { destination: { kind: "chat" }, visibility: { kind: "normal" } };
}

function topicRoute(messageThreadId: number): TelegramReplyRoute {
  return {
    destination: { kind: "topic", messageThreadId },
    visibility: { kind: "normal" },
  };
}

function directRoute(directMessagesTopicId: number): TelegramReplyRoute {
  return {
    destination: { kind: "directMessagesTopic", directMessagesTopicId },
    visibility: { kind: "normal" },
  };
}

function genericThreadRoute(replyToMessageId: number): TelegramReplyRoute {
  return {
    destination: { kind: "genericThread", replyToMessageId },
    visibility: { kind: "normal" },
  };
}

function ephemeralTopicRoute(
  messageThreadId: number,
  receiverUserId: number,
  incomingEphemeralMessageId: number,
): TelegramReplyRoute {
  return {
    destination: { kind: "topic", messageThreadId },
    visibility: { kind: "ephemeral", receiverUserId, incomingEphemeralMessageId },
  };
}
