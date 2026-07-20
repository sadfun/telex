import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodexAppServer,
  CodexAppServerExit,
  ExitListener,
  NotificationListener,
} from "../src/codex/rpc.js";
import { CodexService, type EffectiveCodexSettings } from "../src/codex/service.js";
import type { MessageResponder, OutboundStream } from "../src/core/channel.js";
import { ConversationStore } from "../src/core/conversation-store.js";
import type { ServerNotification } from "../src/generated/codex/ServerNotification.js";
import type { Turn } from "../src/generated/codex/v2/Turn.js";
import { type Deferred, deferred } from "../src/shared/async.js";
import { BridgeError } from "../src/shared/errors.js";
import { Logger } from "../src/shared/logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("CodexService lifecycle", () => {
  it("gates queued jobs while paused and drains only jobs that passed the gate", async () => {
    const { rpc, service } = await testService();
    const first = responder();
    const second = responder();
    const firstRun = service.runTurn("telegram:1", "telegram", "first", first.responder, true);
    await rpc.waitForRequests("turn/start", 1);

    const secondRun = service.runTurn("telegram:1", "telegram", "second", second.responder, true);
    service.pause();
    rpc.completeNextTurn();
    await service.waitForIdle();

    expect(rpc.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(second.stream.start).not.toHaveBeenCalled();

    service.resume();
    await rpc.waitForRequests("turn/start", 2);
    rpc.completeNextTurn();
    await Promise.all([firstRun, secondRun]);
    expect(second.stream.complete).toHaveBeenCalled();
  });

  it("counts work waiting for thread creation as non-idle", async () => {
    const { rpc, service } = await testService();
    const held = deferred<void>();
    rpc.threadStartGate = held;
    const run = service.runTurn("telegram:held", "telegram", "held", responder().responder, true);
    await rpc.waitForRequests("thread/start", 1);

    let idle = false;
    const waiting = service.waitForIdle().then(() => {
      idle = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(idle).toBe(false);

    held.resolve();
    await rpc.waitForRequests("turn/start", 1);
    rpc.completeNextTurn();
    await Promise.all([run, waiting]);
    expect(idle).toBe(true);
  });

  it("rejects an active completion and becomes idle when the transport exits", async () => {
    const { rpc, service } = await testService();
    const output = responder();
    const run = service.runTurn("telegram:exit", "telegram", "work", output.responder, true);
    await rpc.waitForRequests("turn/start", 1);

    rpc.emitExit();
    await Promise.all([run, service.waitForIdle()]);

    expect(output.stream.fail).toHaveBeenCalledWith("transport exited");
  });

  it("reads live settings and skills per turn and resumes stored threads after an exit", async () => {
    let settings: EffectiveCodexSettings = {
      thread: { model: "thread-model-1", modelProvider: "provider-1", sandbox: "read-only" },
      turn: {
        model: "turn-model-1",
        effort: "medium",
        summary: "concise",
        personality: "friendly",
      },
    };
    const skillTexts: string[] = [];
    const { rpc, service } = await testService({
      effectiveSettings: () => settings,
      explicitSkillInputs: (text) => {
        skillTexts.push(text);
        return [{ type: "skill", name: "review", path: "/skills/review/SKILL.md" }];
      },
    });

    const firstRun = service.runTurn(
      "telegram:persistent",
      "telegram",
      "$review first",
      responder().responder,
    );
    await rpc.waitForRequests("turn/start", 1);
    rpc.completeNextTurn();
    await firstRun;

    const start = rpc.requests.find((request) => request.method === "thread/start");
    expect(start?.params).toMatchObject({
      model: "thread-model-1",
      modelProvider: "provider-1",
      sandbox: "read-only",
    });
    expect(rpc.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      model: "turn-model-1",
      effort: "medium",
      summary: "concise",
      personality: "friendly",
      input: [
        { type: "text", text: "$review first" },
        { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
      ],
    });

    settings = {
      thread: { model: "thread-model-2", modelProvider: "provider-2" },
      turn: { model: "turn-model-2", effort: "high", personality: "pragmatic" },
    };
    rpc.emitExit();
    const secondRun = service.runTurn(
      "telegram:persistent",
      "telegram",
      "$review second",
      responder().responder,
    );
    await rpc.waitForRequests("turn/start", 2);
    rpc.completeNextTurn();
    await secondRun;

    const resume = rpc.requests.find((request) => request.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      threadId: "thread-1",
      model: "thread-model-2",
      modelProvider: "provider-2",
    });
    const turns = rpc.requests.filter((request) => request.method === "turn/start");
    expect(turns[1]?.params).toMatchObject({
      model: "turn-model-2",
      effort: "high",
      personality: "pragmatic",
    });
    expect(skillTexts).toEqual(["$review first", "$review second"]);
  });

  it("keeps a stored thread when resume fails because the transport is unavailable", async () => {
    const { rpc, service } = await testService();
    const firstRun = service.runTurn("telegram:stored", "telegram", "first", responder().responder);
    await rpc.waitForRequests("turn/start", 1);
    rpc.completeNextTurn();
    await firstRun;

    rpc.emitExit();
    rpc.resumeError = new BridgeError("not running", "CODEX_NOT_RUNNING");
    const failed = responder();
    await service.runTurn("telegram:stored", "telegram", "while down", failed.responder);
    expect(failed.stream.fail).toHaveBeenCalledWith("not running");

    rpc.resumeError = undefined;
    const resumed = service.runTurn(
      "telegram:stored",
      "telegram",
      "after restart",
      responder().responder,
    );
    await rpc.waitForRequests("turn/start", 2);
    rpc.completeNextTurn();
    await resumed;
    const resumeRequests = rpc.requests.filter((request) => request.method === "thread/resume");
    expect(resumeRequests).toHaveLength(2);
    expect(resumeRequests[1]?.params).toMatchObject({ threadId: "thread-1" });
  });
});

interface RpcRequest {
  readonly method: string;
  readonly params?: unknown;
}

interface PendingTurn {
  readonly threadId: string;
  readonly turnId: string;
}

class ControlledRpc {
  readonly requests: RpcRequest[] = [];
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #exitListeners = new Set<ExitListener>();
  readonly #pendingTurns: PendingTurn[] = [];
  #nextTurn = 1;
  public threadStartGate: Deferred<void> | undefined;
  public resumeError: BridgeError | undefined;

  public onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  public onExit(listener: ExitListener): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  public setServerRequestHandler(): void {}

  public async request<Result>(request: RpcRequest): Promise<Result> {
    this.requests.push(request);
    if (request.method === "thread/start") {
      await this.threadStartGate?.promise;
      return { thread: { id: "thread-1" } } as Result;
    }
    if (request.method === "thread/resume") {
      if (this.resumeError !== undefined) throw this.resumeError;
      const { threadId } = request.params as { readonly threadId: string };
      return { thread: { id: threadId } } as Result;
    }
    if (request.method === "turn/start") {
      const { threadId } = request.params as { readonly threadId: string };
      const turnId = `turn-${this.#nextTurn}`;
      this.#nextTurn += 1;
      this.#pendingTurns.push({ threadId, turnId });
      return { turn: { id: turnId } } as Result;
    }
    throw new Error(`Unexpected request ${request.method}`);
  }

  public async waitForRequests(method: string, count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(this.requests.filter((request) => request.method === method)).toHaveLength(count);
    });
  }

  public completeNextTurn(): void {
    const pending = this.#pendingTurns.shift();
    if (pending === undefined) throw new Error("No pending turn");
    this.notify({
      method: "turn/completed",
      params: { threadId: pending.threadId, turn: completedTurn(pending.turnId) },
    } as ServerNotification);
  }

  public emitExit(): void {
    const error = new BridgeError("transport exited", "CODEX_EXITED");
    const exit = {
      error,
      expected: false,
      code: 1,
      signal: null,
    } satisfies CodexAppServerExit;
    for (const listener of this.#exitListeners) listener(exit);
  }

  private notify(notification: ServerNotification): void {
    for (const listener of this.#notificationListeners) listener(notification);
  }
}

function responder(): Readonly<{ responder: MessageResponder; stream: OutboundStream }> {
  const stream: OutboundStream = {
    start: vi.fn(async () => undefined),
    setProgress: vi.fn(),
    appendFinal: vi.fn(),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
  return {
    stream,
    responder: {
      createStream: () => stream,
      sendText: vi.fn(async () => undefined),
      askChoice: vi.fn(async () => "decline"),
    },
  };
}

function completedTurn(id: string): Turn {
  return {
    id,
    items: [],
    itemsView: "notLoaded",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

async function testService(
  providers: ConstructorParameters<typeof CodexService>[8] = {},
): Promise<Readonly<{ rpc: ControlledRpc; service: CodexService }>> {
  const directory = await mkdtemp(join(tmpdir(), "telex-codex-lifecycle-"));
  temporaryDirectories.push(directory);
  const workspace = join(directory, "workspace");
  const generatedImages = join(directory, "generated-images");
  const outbound = join(directory, "outbound");
  await Promise.all([mkdir(workspace), mkdir(generatedImages), mkdir(outbound)]);
  const conversations = new ConversationStore(
    join(directory, "conversations.json"),
    new Logger("error"),
  );
  await conversations.load();
  const rpc = new ControlledRpc();
  const service = new CodexService(
    rpc as unknown as CodexAppServer,
    conversations,
    workspace,
    generatedImages,
    outbound,
    new Logger("error"),
    undefined,
    () => false,
    providers,
  );
  return { rpc, service };
}
