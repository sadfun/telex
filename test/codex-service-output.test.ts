import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServer, NotificationListener } from "../src/codex/rpc.js";
import { CodexService } from "../src/codex/service.js";
import type { MessageResponder, OutboundAttachment, OutboundStream } from "../src/core/channel.js";
import { ConversationStore } from "../src/core/conversation-store.js";
import type { ServerNotification } from "../src/generated/codex/ServerNotification.js";
import type { ThreadItem } from "../src/generated/codex/v2/ThreadItem.js";
import type { Turn } from "../src/generated/codex/v2/Turn.js";
import { Logger } from "../src/shared/logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("CodexService outbound files", () => {
  it("uses completed item notifications when turn/completed omits its items", async () => {
    const dataDirectory = await temporaryDirectory();
    const workspace = join(dataDirectory, "workspace");
    const generatedImages = join(dataDirectory, "codex-home", "generated_images");
    const outbound = join(dataDirectory, "outbound");
    await mkdir(workspace);
    await mkdir(generatedImages, { recursive: true });
    await mkdir(outbound);
    const image = join(generatedImages, "image.png");
    const report = join(workspace, "report.pdf");
    await writeFile(image, "image");
    await writeFile(report, "report");
    const finalText =
      "Created [the report](report.pdf), but [the archive](missing.zip) is missing.";
    const rpc = new FakeCodexRpc(completedTurn(), finalText, image);
    const delivered: Array<Readonly<{ filename: string; contents: string }>> = [];
    const complete = vi.fn(
      async (_text: string, attachments: readonly OutboundAttachment[] = []) => {
        for (const attachment of attachments) {
          delivered.push({
            filename: attachment.filename,
            contents: await readFile(attachment.path, "utf8"),
          });
        }
      },
    );
    const stream: OutboundStream = {
      start: vi.fn(async () => undefined),
      setProgress: vi.fn(),
      appendFinal: vi.fn(),
      complete,
      fail: vi.fn(async () => undefined),
    };
    const responder = {
      createStream: () => stream,
      sendText: vi.fn(async () => undefined),
      askChoice: vi.fn(async () => "decline"),
    } satisfies MessageResponder;
    const service = new CodexService(
      rpc as unknown as CodexAppServer,
      new ConversationStore(join(dataDirectory, "conversations.json"), new Logger("error")),
      workspace,
      generatedImages,
      outbound,
      new Logger("error"),
    );

    await service.runTurn("telegram:42", "make a report", responder, true);

    expect(complete).toHaveBeenCalledWith(
      `Could not attach missing.zip.\n\n${finalText}`,
      expect.any(Array),
    );
    expect(delivered).toEqual([
      { filename: "image.png", contents: "image" },
      { filename: "report.pdf", contents: "report" },
    ]);
  });
});

class FakeCodexRpc {
  readonly #turn: Turn;
  readonly #finalText: string;
  readonly #image: string;
  #listener: NotificationListener | undefined;

  public constructor(turn: Turn, finalText: string, image: string) {
    this.#turn = turn;
    this.#finalText = finalText;
    this.#image = image;
  }

  public onNotification(listener: NotificationListener): () => void {
    this.#listener = listener;
    return () => undefined;
  }

  public setServerRequestHandler(): void {}

  public async request<Result>(request: { readonly method: string }): Promise<Result> {
    if (request.method === "thread/start") {
      return { thread: { id: "thread-1" } } as Result;
    }
    if (request.method === "turn/start") {
      queueMicrotask(() => {
        this.completeItem({
          type: "imageGeneration",
          id: "image-1",
          status: "completed",
          revisedPrompt: null,
          result: "",
          savedPath: this.#image,
        });
        this.completeItem({
          type: "agentMessage",
          id: "message-1",
          text: this.#finalText,
          phase: "final_answer",
          memoryCitation: null,
        });
        this.#listener?.({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: this.#turn },
        } as ServerNotification);
      });
      return { turn: { id: this.#turn.id } } as Result;
    }
    throw new Error(`Unexpected request ${request.method}`);
  }

  private completeItem(item: ThreadItem): void {
    this.#listener?.({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: this.#turn.id,
        item,
        completedAtMs: Date.now(),
      },
    } as ServerNotification);
  }
}

function completedTurn(): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "notLoaded",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "telex-service-output-"));
  temporaryDirectories.push(path);
  return path;
}
