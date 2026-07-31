import { describe, expect, it, vi } from "vitest";
import type {
  CodexAppServer,
  CodexAppServerExit,
  ExitListener,
  NotificationListener,
} from "../src/codex/rpc.js";
import { CodexRuntimeService } from "../src/codex/runtime-service.js";
import type { CodexService } from "../src/codex/service.js";
import type { ServerNotification } from "../src/generated/codex/ServerNotification.js";
import type { ConfigReadResponse } from "../src/generated/codex/v2/ConfigReadResponse.js";
import type { SkillMetadata } from "../src/generated/codex/v2/SkillMetadata.js";
import type { SkillsListResponse } from "../src/generated/codex/v2/SkillsListResponse.js";
import { BridgeError } from "../src/shared/errors.js";
import type { Logger } from "../src/shared/logger.js";

const workspace = "/workspace";

describe("CodexRuntimeService", () => {
  it("primes effective settings and explicit skill inputs", async () => {
    const rpc = new FakeRuntimeRpc();
    const codex = fakeCodex();
    const runtime = createRuntime(rpc, codex);

    const status = await runtime.start();

    expect(status).toEqual({
      state: "ready",
      restartRequired: false,
      lastError: null,
      lastAppliedAt: expect.any(String),
      configPath: "/tmp/codex/config.toml",
    });
    expect(rpc.requests.map((request) => request.method)).toEqual(["config/read", "skills/list"]);
    expect(runtime.settings()).toMatchObject({
      thread: {
        model: "gpt-test",
        modelProvider: "openai",
        sandbox: "workspace-write",
      },
      turn: {
        model: "gpt-test",
        effort: "high",
        personality: "pragmatic",
      },
    });
    expect(runtime.skillInputs("please use $go-code-review.")).toEqual([
      { type: "skill", name: "go-code-review", path: "/skills/go/SKILL.md" },
    ]);
    expect(runtime.skillInputs("$go-code-reviewer is a different token")).toEqual([]);
    expect(runtime.skillInputs("Run ($github:yeet), then $go-code-review.")).toEqual([
      { type: "skill", name: "github:yeet", path: "/skills/github-yeet/SKILL.md" },
      { type: "skill", name: "go-code-review", path: "/skills/go/SKILL.md" },
    ]);

    await runtime.stop();
  });

  it("reports remaining weekly and optional five-hour usage windows", async () => {
    const rpc = new FakeRuntimeRpc();
    const runtime = createRuntime(rpc, fakeCodex());

    expect(await runtime.usageLimits()).toEqual({
      weekly: { remainingPercent: 72.5, resetsAt: 1_800_604_800 },
      fiveHour: { remainingPercent: 42, resetsAt: 1_800_018_000 },
      bankedResets: {
        availableCount: 2,
        credits: [
          {
            id: "reset-1",
            resetType: "codexRateLimits",
            status: "available",
            grantedAt: 1_799_000_000,
            expiresAt: 1_801_000_000,
            title: "Usage reset",
            description: "Restores eligible Codex limits.",
          },
        ],
      },
    });
    expect(rpc.requests.at(-1)).toEqual({
      method: "account/rateLimits/read",
      params: undefined,
    });

    rpc.rateLimits = {
      rateLimits: {
        primary: {
          usedPercent: 27.5,
          windowDurationMins: 10_080,
          resetsAt: 1_800_604_800,
        },
        secondary: null,
      },
      rateLimitResetCredits: null,
    };
    expect(await runtime.usageLimits()).toEqual({
      weekly: { remainingPercent: 72.5, resetsAt: 1_800_604_800 },
      fiveHour: null,
      bankedResets: null,
    });
  });

  it("applies a specific banked reset with the native idempotent RPC", async () => {
    const rpc = new FakeRuntimeRpc();
    const runtime = createRuntime(rpc, fakeCodex());

    expect(await runtime.applyBankedReset("reset-1", "attempt-1")).toBe("reset");
    expect(rpc.requests.at(-1)).toEqual({
      method: "account/rateLimitResetCredit/consume",
      params: {
        creditId: "reset-1",
        idempotencyKey: "attempt-1",
      },
    });
  });

  it("runs the native config, MCP, and skill reload cascade", async () => {
    const rpc = new FakeRuntimeRpc();
    const runtime = createRuntime(rpc, fakeCodex());
    await runtime.start();
    rpc.requests.length = 0;

    const status = await runtime.reload();

    expect(rpc.requests.map((request) => request.method)).toEqual([
      "config/read",
      "config/batchWrite",
      "config/read",
      "config/mcpServer/reload",
      "skills/list",
    ]);
    expect(rpc.requests[1]).toEqual({
      method: "config/batchWrite",
      params: {
        edits: [],
        reloadUserConfig: true,
        filePath: "/tmp/codex/config.toml",
        expectedVersion: "user-v1",
      },
    });
    expect(status).toMatchObject({
      state: "ready",
      restartRequired: false,
      lastError: null,
    });

    await runtime.stop();
  });

  it("does not repeat the config write after a Mini App save already hot-reloaded it", async () => {
    const rpc = new FakeRuntimeRpc();
    const runtime = createRuntime(rpc, fakeCodex());
    await runtime.start();
    rpc.requests.length = 0;

    await runtime.afterConfigWrite();

    expect(rpc.requests.map((request) => request.method)).toEqual([
      "config/read",
      "config/mcpServer/reload",
      "skills/list",
    ]);

    await runtime.stop();
  });

  it("keeps a model-provider change pending until the child restarts", async () => {
    const rpc = new FakeRuntimeRpc();
    const runtime = createRuntime(rpc, fakeCodex());
    const initial = await runtime.start();
    rpc.config = configResponse("user-v2", "azure");

    const reloaded = await runtime.reload();

    expect(reloaded).toMatchObject({
      state: "ready",
      restartRequired: true,
      lastAppliedAt: initial.lastAppliedAt,
    });
    expect(runtime.settings().thread?.modelProvider).toBe("azure");
    expect((await runtime.reload()).restartRequired).toBe(true);

    const restarted = await runtime.restart();
    expect(restarted).toMatchObject({ state: "ready", restartRequired: false });

    await runtime.stop();
  });

  it("refreshes skills when Codex announces a skills change", async () => {
    const rpc = new FakeRuntimeRpc();
    const runtime = createRuntime(rpc, fakeCodex());
    await runtime.start();
    rpc.skills = skillsResponse([
      {
        name: "fresh-skill",
        description: "Fresh",
        path: "/skills/fresh/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
    rpc.requests.length = 0;

    rpc.emitNotification({ method: "skills/changed", params: {} } as ServerNotification);

    await vi.waitFor(() => {
      expect(runtime.skills().map((skill) => skill.name)).toEqual(["fresh-skill"]);
    });
    expect(rpc.requests.map((request) => request.method)).toEqual(["skills/list"]);
    expect(runtime.status()).toMatchObject({ state: "ready", lastError: null });

    await runtime.stop();
  });

  it("drains turns and restarts the child app-server", async () => {
    const rpc = new FakeRuntimeRpc();
    const codex = fakeCodex();
    const runtime = createRuntime(rpc, codex);
    await runtime.start();
    rpc.requests.length = 0;

    const status = await runtime.restart();

    expect(codex.pause).toHaveBeenCalledOnce();
    expect(codex.waitForIdle).toHaveBeenCalledOnce();
    expect(rpc.stop).toHaveBeenCalledOnce();
    expect(rpc.start).toHaveBeenCalledOnce();
    expect(codex.resume).toHaveBeenCalledOnce();
    expect(rpc.requests.map((request) => request.method)).toEqual([
      "config/read",
      "config/read",
      "skills/list",
    ]);
    expect(status).toMatchObject({ state: "ready", restartRequired: false });

    await runtime.stop();
  });

  it("keeps the healthy child and prior settings when restart preflight is invalid", async () => {
    const rpc = new FakeRuntimeRpc();
    const codex = fakeCodex();
    const runtime = createRuntime(rpc, codex);
    await runtime.start();
    const before = runtime.settings();
    rpc.failNextConfigRead = new Error("invalid external config");

    const status = await runtime.restart();

    expect(rpc.stop).not.toHaveBeenCalled();
    expect(rpc.start).not.toHaveBeenCalled();
    expect(codex.resume).not.toHaveBeenCalled();
    expect(runtime.settings()).toBe(before);
    expect(status).toMatchObject({
      state: "degraded",
      restartRequired: false,
      lastError: "invalid external config",
    });

    await runtime.stop();
  });

  it("restarts without preflight when the child is already down", async () => {
    const rpc = new FakeRuntimeRpc();
    const runtime = createRuntime(rpc, fakeCodex());
    await runtime.start();
    rpc.failNextConfigRead = new BridgeError("not running", "CODEX_NOT_RUNNING");

    const status = await runtime.restart();

    expect(rpc.stop).toHaveBeenCalledOnce();
    expect(rpc.start).toHaveBeenCalledOnce();
    expect(status.state).toBe("ready");

    await runtime.stop();
  });

  it("keeps turns gated after startup failure and releases them after a retry", async () => {
    const rpc = new FakeRuntimeRpc();
    const codex = fakeCodex();
    const runtime = createRuntime(rpc, codex);
    await runtime.start();
    rpc.startError = new Error("initialize failed");

    const failed = await runtime.restart();

    expect(failed).toMatchObject({ state: "degraded", restartRequired: true });
    expect(codex.resume).not.toHaveBeenCalled();

    rpc.startError = undefined;
    const recovered = await runtime.restart();
    expect(recovered.state).toBe("ready");
    expect(codex.resume).toHaveBeenCalledOnce();

    await runtime.stop();
  });
});

interface RecordedRequest {
  readonly method: string;
  readonly params?: unknown;
}

class FakeRuntimeRpc {
  readonly requests: RecordedRequest[] = [];
  readonly #notifications = new Set<NotificationListener>();
  readonly #exits = new Set<ExitListener>();
  public config = configResponse("user-v1");
  public skills: SkillsListResponse = skillsResponse();
  public rateLimits: {
    rateLimits: {
      primary: {
        usedPercent: number;
        windowDurationMins: number;
        resetsAt: number;
      };
      secondary: {
        usedPercent: number;
        windowDurationMins: number;
        resetsAt: number;
      } | null;
    };
    rateLimitResetCredits: {
      availableCount: bigint;
      credits: [
        {
          id: string;
          resetType: "codexRateLimits";
          status: "available";
          grantedAt: number;
          expiresAt: number;
          title: string;
          description: string;
        },
      ];
    } | null;
  } = {
    rateLimits: {
      primary: {
        usedPercent: 58,
        windowDurationMins: 300,
        resetsAt: 1_800_018_000,
      },
      secondary: {
        usedPercent: 27.5,
        windowDurationMins: 10_080,
        resetsAt: 1_800_604_800,
      },
    },
    rateLimitResetCredits: {
      availableCount: 2n,
      credits: [
        {
          id: "reset-1",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1_799_000_000,
          expiresAt: 1_801_000_000,
          title: "Usage reset",
          description: "Restores eligible Codex limits.",
        },
      ],
    },
  };
  public failNextConfigRead: Error | undefined;
  public startError: Error | undefined;
  public readonly start = vi.fn(async () => {
    if (this.startError !== undefined) throw this.startError;
    return { userAgent: "test", platformOs: "macos" };
  });
  public readonly stop = vi.fn(async () => {
    const exit: CodexAppServerExit = {
      expected: true,
      code: 0,
      signal: null,
      error: new BridgeError("Codex app-server exited (0)", "CODEX_EXITED"),
    };
    for (const listener of this.#exits) listener(exit);
  });

  public onNotification(listener: NotificationListener): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  public onExit(listener: ExitListener): () => void {
    this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }

  public emitNotification(notification: ServerNotification): void {
    for (const listener of this.#notifications) listener(notification);
  }

  public async request<Result>(request: RecordedRequest): Promise<Result> {
    this.requests.push(request);
    switch (request.method) {
      case "config/read":
        if (this.failNextConfigRead !== undefined) {
          const error = this.failNextConfigRead;
          this.failNextConfigRead = undefined;
          throw error;
        }
        return this.config as Result;
      case "skills/list":
        return this.skills as Result;
      case "account/rateLimits/read":
        return this.rateLimits as Result;
      case "account/rateLimitResetCredit/consume":
        return { outcome: "reset" } as Result;
      case "config/batchWrite":
      case "config/mcpServer/reload":
        return {} as Result;
      default:
        throw new Error(`Unexpected runtime request: ${request.method}`);
    }
  }
}

function createRuntime(rpc: FakeRuntimeRpc, codex: ReturnType<typeof fakeCodex>) {
  return new CodexRuntimeService({
    rpc: rpc as unknown as CodexAppServer,
    codex: codex as unknown as CodexService,
    configService: { invalidateCapabilities: vi.fn() },
    workspace,
    logger: testLogger(),
  });
}

function fakeCodex() {
  return {
    pause: vi.fn(),
    waitForIdle: vi.fn(async () => undefined),
    resume: vi.fn(),
  };
}

function configResponse(userVersion: string, modelProvider = "openai"): ConfigReadResponse {
  return {
    config: {
      model: "gpt-test",
      model_provider: modelProvider,
      service_tier: "fast",
      approval_policy: "on-request",
      approvals_reviewer: "user",
      sandbox_mode: "workspace-write",
      instructions: null,
      developer_instructions: null,
      model_reasoning_effort: "high",
      model_reasoning_summary: "concise",
      personality: "pragmatic",
    },
    origins: {},
    layers: [
      {
        name: { type: "user", file: "/tmp/codex/config.toml", profile: null },
        version: userVersion,
        config: {},
        disabledReason: null,
      },
      {
        name: { type: "project", dotCodexFolder: "/workspace/.codex" },
        version: "project-v1",
        config: {},
        disabledReason: null,
      },
    ],
  } as unknown as ConfigReadResponse;
}

function skillsResponse(
  skills: SkillMetadata[] = [
    {
      name: "go-code-review",
      description: "Review Go code",
      path: "/skills/go/SKILL.md",
      scope: "user",
      enabled: true,
    },
    {
      name: "disabled-skill",
      description: "Disabled",
      path: "/skills/disabled/SKILL.md",
      scope: "user",
      enabled: false,
    },
    {
      name: "github",
      description: "GitHub routing",
      path: "/skills/github/SKILL.md",
      scope: "user",
      enabled: true,
    },
    {
      name: "github:yeet",
      description: "Publish changes",
      path: "/skills/github-yeet/SKILL.md",
      scope: "user",
      enabled: true,
    },
  ],
): SkillsListResponse {
  return {
    data: [
      {
        cwd: workspace,
        skills,
        errors: [],
      },
    ],
  };
}

function testLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}
