import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServer, type CodexAppServerExit } from "../src/codex/rpc.js";
import { Logger } from "../src/shared/logger.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

const children: FakeChild[] = [];
let initializeFailure = false;

beforeEach(() => {
  children.length = 0;
  initializeFailure = false;
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcessWithoutNullStreams;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CodexAppServer lifecycle", () => {
  it("rejects pending requests and notifies listeners once when the child exits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rpc = appServer();
    const exits: CodexAppServerExit[] = [];
    rpc.onExit((exit) => exits.push(exit));
    await rpc.start();
    const child = onlyChild();
    const pending = rpc.request({
      method: "account/read",
      params: { refreshToken: false },
    });

    child.exit(7, null);
    await expect(pending).rejects.toMatchObject({ code: "CODEX_EXITED" });
    expect(exits).toMatchObject([
      { expected: false, code: 7, signal: null, error: { code: "CODEX_EXITED" } },
    ]);

    child.emit("error", new Error("late child error"));
    expect(exits).toHaveLength(1);
  });

  it("restarts cleanly and ignores late events and output from the previous child", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rpc = appServer();
    const exits: CodexAppServerExit[] = [];
    rpc.onExit((exit) => exits.push(exit));
    await rpc.start();
    const first = onlyChild();
    first.exitOnTerminate = true;
    await rpc.stop();
    expect(exits[0]?.expected).toBe(true);

    await rpc.start();
    const second = children[1];
    if (second === undefined) throw new Error("Second child was not spawned");
    const pending = rpc.request({
      method: "account/read",
      params: { refreshToken: false },
    });
    first.emit("error", new Error("stale error"));
    first.send({ id: 3, result: { account: "stale" } });
    expect(exits).toHaveLength(1);

    second.respond("account/read", { account: "current" });
    await expect(pending).resolves.toEqual({ account: "current" });
    second.exit(1, null);
    expect(exits[1]?.expected).toBe(false);
  });

  it("sends SIGKILL after the grace period and still waits for the child to exit", async () => {
    vi.useFakeTimers();
    const rpc = appServer();
    await rpc.start();
    const child = onlyChild();
    let stopped = false;
    const stopping = rpc.stop().then(() => {
      stopped = true;
    });

    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(stopped).toBe(false);

    child.exit(null, "SIGKILL");
    await stopping;
    expect(stopped).toBe(true);
  });

  it("cleans up a child that fails initialization so start can be retried", async () => {
    initializeFailure = true;
    const rpc = appServer();
    const firstStart = rpc.start();
    const first = onlyChild();
    first.exitOnTerminate = true;

    await expect(firstStart).rejects.toThrow("initialization failed");
    expect(first.kills).toEqual(["SIGTERM"]);

    initializeFailure = false;
    await expect(rpc.start()).resolves.toMatchObject({ userAgent: "fake-codex" });
    const second = children[1];
    if (second === undefined) throw new Error("Second child was not spawned");
    second.exitOnTerminate = true;
    await rpc.stop();
  });
});

interface WireRequest {
  readonly id?: string | number;
  readonly method?: string;
}

class FakeChild extends EventEmitter {
  public readonly stdin: Writable;
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly kills: (NodeJS.Signals | number)[] = [];
  public readonly messages: WireRequest[] = [];
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public exitOnTerminate = false;

  public constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const request = JSON.parse(String(chunk).trim()) as WireRequest;
        this.messages.push(request);
        if (request.method === "initialize") {
          if (initializeFailure) {
            this.send({ id: request.id, error: { code: -1, message: "initialization failed" } });
          } else {
            this.send({
              id: request.id,
              result: {
                userAgent: "fake-codex",
                codexHome: "/tmp/fake-codex-home",
                platformFamily: "unix",
                platformOs: "linux",
              },
            });
          }
        }
        callback();
      },
    });
  }

  public readonly kill = vi.fn((signal: NodeJS.Signals | number = "SIGTERM") => {
    this.kills.push(signal);
    if (signal === "SIGTERM" && this.exitOnTerminate) this.exit(null, "SIGTERM");
    return true;
  });

  public respond(method: string, result: unknown): void {
    const request = this.messages.findLast((message) => message.method === method);
    if (request?.id === undefined) throw new Error(`No ${method} request`);
    this.send({ id: request.id, result });
  }

  public send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  public exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function appServer(): CodexAppServer {
  return new CodexAppServer(
    "/fake/codex",
    "/workspace",
    "/codex-home",
    "test",
    new Logger("error"),
  );
}

function onlyChild(): FakeChild {
  const child = children[0];
  if (child === undefined) throw new Error("Child was not spawned");
  return child;
}
