import { describe, expect, it } from "vitest";
import { createTurnInput } from "../src/codex/service.js";

describe("createTurnInput", () => {
  it("keeps the existing text-only protocol shape", () => {
    expect(createTurnInput("hello", [])).toEqual([
      { type: "text", text: "hello", text_elements: [] },
    ]);
  });

  it("uses native localImage inputs for supported Telegram images", () => {
    expect(
      createTurnInput("What is in this?", [
        { kind: "image", path: "/workspace/photo.jpg", description: "Telegram photo" },
        { kind: "image", path: "/workspace/sticker.webp", description: "Telegram sticker" },
      ]),
    ).toEqual([
      { type: "text", text: "What is in this?", text_elements: [] },
      { type: "localImage", path: "/workspace/photo.jpg" },
      { type: "localImage", path: "/workspace/sticker.webp" },
    ]);
  });

  it("references generic files in text instead of inventing a protocol input type", () => {
    expect(
      createTurnInput("Summarize these", [
        { kind: "file", path: "/workspace/clip.mp4", description: "Telegram video" },
        { kind: "image", path: "/workspace/cover.jpg", description: "Video thumbnail" },
      ]),
    ).toEqual([
      {
        type: "text",
        text: `Summarize these

Telegram files available in the local workspace:
- Telegram video: "/workspace/clip.mp4"`,
        text_elements: [],
      },
      { type: "localImage", path: "/workspace/cover.jpg" },
    ]);
  });

  it("keeps the original voice attachment alongside its transcript", () => {
    expect(
      createTurnInput("Voice message transcript:\nHello Telex.", [
        {
          kind: "voice",
          path: "/workspace/voice.ogg",
          description: "Telegram voice message",
        },
      ]),
    ).toEqual([
      {
        type: "text",
        text: `Voice message transcript:
Hello Telex.

Telegram files available in the local workspace:
- Telegram voice message: "/workspace/voice.ogg"`,
        text_elements: [],
      },
    ]);
  });
});
