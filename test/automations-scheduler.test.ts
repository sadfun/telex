import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AutomationDefinition,
  type AutomationExecutionGate,
  type AutomationRunner,
  AutomationScheduler,
  AutomationStore,
} from "../src/automations/index.js";
import { deferred } from "../src/shared/async.js";
import type { Logger } from "../src/shared/logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("AutomationScheduler", () => {
  it("coalesces missed occurrences and respects maximum concurrency", async () => {
    const store = await createStore();
    await Promise.all([
      store.putAutomation(automation("automation-1", "2026-07-21T07:00:00Z")),
      store.putAutomation(automation("automation-2", "2026-07-21T08:00:00Z")),
      store.putAutomation(automation("automation-3", "2026-07-21T09:00:00Z")),
    ]);
    const completions = [deferred<void>(), deferred<void>(), deferred<void>()];
    let started = 0;
    const runner: AutomationRunner = {
      run: async () => {
        const completion = completions[started];
        started += 1;
        await completion?.promise;
        return {};
      },
    };
    let id = 0;
    const scheduler = new AutomationScheduler({
      store,
      runner,
      logger: testLogger(),
      maxConcurrency: 2,
      now: () => new Date("2026-07-21T10:00:00Z"),
      createId: () => {
        id += 1;
        return `run-${id}`;
      },
    });

    await scheduler.tick();

    expect(started).toBe(2);
    expect(scheduler.activeCount).toBe(2);
    expect(store.listRuns()).toHaveLength(2);
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00.000Z");
    expect(store.getAutomation("automation-2")?.nextRunAt).toBe("2026-07-21T11:00:00.000Z");
    expect(store.getAutomation("automation-3")?.nextRunAt).toBe("2026-07-21T09:00:00Z");

    completions[0]?.resolve();
    completions[1]?.resolve();
    await scheduler.waitForIdle();
    await scheduler.tick();
    expect(started).toBe(3);
    completions[2]?.resolve();
    await scheduler.stop();
  });

  it("defers without claiming when the foreground conversation is busy", async () => {
    const store = await createStore();
    await store.putAutomation(automation("automation-1", "2026-07-21T10:00:00Z"));
    const runner = { run: vi.fn(async () => ({})) } satisfies AutomationRunner;
    const gate: AutomationExecutionGate = {
      tryAcquire: () => ({ acquired: false, reason: "A user turn is active." }),
    };
    const scheduler = new AutomationScheduler({
      store,
      runner,
      gate,
      logger: testLogger(),
      deferralMs: 45_000,
      now: () => new Date("2026-07-21T10:00:00Z"),
    });

    await scheduler.tick();

    expect(runner.run).not.toHaveBeenCalled();
    expect(store.listRuns()).toHaveLength(0);
    expect(store.getAutomation("automation-1")).toMatchObject({
      nextRunAt: "2026-07-21T10:00:00Z",
      deferredUntil: "2026-07-21T10:00:45.000Z",
      deferralReason: "A user turn is active.",
    });
  });

  it("marks stale running records interrupted during initialization", async () => {
    const store = await createStore();
    await store.putAutomation(automation("automation-1", "2026-07-21T10:00:00Z"));
    await store.claimRun({
      automationId: "automation-1",
      expectedNextRunAt: "2026-07-21T10:00:00Z",
      nextRunAt: "2026-07-21T11:00:00Z",
      run: {
        id: "old-run",
        automationId: "automation-1",
        scheduledFor: "2026-07-21T10:00:00Z",
        status: "running",
        startedAt: "2026-07-21T10:00:00Z",
        finishedAt: null,
        threadId: null,
        summary: null,
        error: null,
      },
    });
    await store.putNotification({
      id: "pending-notification",
      automationId: "automation-1",
      runId: "old-run",
      target: { provider: "example", resource: "destination", id: "room-1" },
      publishedMessages: [],
      sourceThreadId: "thread-1",
      status: "pending",
      title: "Status",
      body: "Unconfirmed",
      error: null,
      createdAt: "2026-07-21T10:01:00Z",
      updatedAt: "2026-07-21T10:01:00Z",
    });
    const scheduler = new AutomationScheduler({
      store,
      runner: { run: async () => ({}) },
      logger: testLogger(),
      now: () => new Date("2026-07-21T10:05:00Z"),
    });

    await scheduler.initialize();

    expect(store.getRun("old-run")?.status).toBe("interrupted");
    expect(store.getNotification("pending-notification")).toMatchObject({
      status: "failed",
      error: "Telex restarted before notification delivery was confirmed.",
    });
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00Z");
  });

  it("records failures and releases the conversation lease", async () => {
    const store = await createStore();
    await store.putAutomation(automation("automation-1", "2026-07-21T10:00:00Z"));
    const release = vi.fn();
    const scheduler = new AutomationScheduler({
      store,
      runner: {
        run: () => {
          throw new Error("Codex stopped");
        },
      },
      gate: {
        tryAcquire: () => ({ acquired: true, lease: { release } }),
      },
      logger: testLogger(),
      now: () => new Date("2026-07-21T10:00:00Z"),
      createId: () => "failed-run",
    });

    await scheduler.tick();
    await scheduler.waitForIdle();

    expect(store.getRun("failed-run")).toMatchObject({
      status: "failed",
      error: "Codex stopped",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("marks an in-flight run interrupted during shutdown", async () => {
    const store = await createStore();
    await store.putAutomation(automation("automation-1", "2026-07-21T10:00:00Z"));
    const completion = deferred<void>();
    const scheduler = new AutomationScheduler({
      store,
      runner: {
        run: async () => {
          await completion.promise;
          return {};
        },
      },
      logger: testLogger(),
      now: () => new Date("2026-07-21T10:00:00Z"),
      createId: () => "interrupted-run",
    });

    await scheduler.tick();
    const stopping = scheduler.stop();
    completion.reject(new Error("Codex turn was interrupted"));
    await stopping;

    expect(store.getRun("interrupted-run")).toMatchObject({
      status: "interrupted",
      error: "Telex stopped before the scheduled run completed.",
    });
  });
});

async function createStore(): Promise<AutomationStore> {
  const directory = await mkdtemp(join(tmpdir(), "telex-scheduler-"));
  directories.push(directory);
  const store = new AutomationStore(join(directory, "automations.json"), testLogger());
  await store.load();
  return store;
}

function automation(id: string, nextRunAt: string): AutomationDefinition {
  return {
    id,
    owner: { provider: "example", resource: "user", id: "user-1" },
    conversation: { provider: "example", resource: "conversation", id: "room-1" },
    deliveryTarget: { provider: "example", resource: "conversation", id: "room-1" },
    kind: "cron",
    name: id,
    prompt: "Check the status",
    status: "active",
    schedule: {
      rrule: "FREQ=HOURLY",
      startAt: nextRunAt,
      timeZone: "UTC",
    },
    execution: { mode: "new-thread", cwd: "/workspace" },
    notificationPolicy: "on-result",
    model: null,
    reasoningEffort: null,
    nextRunAt,
    lastRunAt: null,
    deferredUntil: null,
    deferralReason: null,
    createdAt: nextRunAt,
    updatedAt: nextRunAt,
    revision: 0,
  };
}

function testLogger(): Logger {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}
