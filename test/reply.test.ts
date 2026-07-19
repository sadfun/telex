import type { Api } from "grammy";
import type { Chat, InputRichMessageWithoutUpload } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatThinkingBlock,
  splitTelegramText,
  TelegramResponder,
} from "../src/channels/telegram/reply.js";
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

describe("Telegram streaming", () => {
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
});

function createStream(apiOverrides: Readonly<Record<string, unknown>>) {
  const api = {
    sendRichMessageDraft: vi.fn(async () => true),
    sendMessageDraft: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
    sendRichMessage: vi.fn(async () => ({ message_id: 1 })),
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    ...apiOverrides,
  } as unknown as Api;
  const chat = { id: 42, type: "private", first_name: "Ada" } satisfies Chat.PrivateChat;
  const responder = new TelegramResponder(
    api,
    chat,
    undefined,
    42,
    async () => "decline",
    new Logger("error"),
  );
  return responder.createStream();
}
