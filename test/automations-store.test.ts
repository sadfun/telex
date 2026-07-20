import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AutomationDefinition,
  type AutomationNotification,
  type AutomationRun,
  AutomationStore,
} from "../src/automations/index.js";
import { Logger } from "../src/shared/logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("AutomationStore", () => {
  it("atomically claims a due occurrence only once and persists the advanced schedule", async () => {
    const { path, store } = await createStore();
    await store.putAutomation(automation());
    const run = runningRun("run-1");

    const claims = await Promise.all([
      store.claimRun({
        automationId: "automation-1",
        expectedNextRunAt: "2026-07-21T10:00:00Z",
        nextRunAt: "2026-07-21T11:00:00Z",
        run,
      }),
      store.claimRun({
        automationId: "automation-1",
        expectedNextRunAt: "2026-07-21T10:00:00Z",
        nextRunAt: "2026-07-21T11:00:00Z",
        run: runningRun("run-2"),
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00Z");
    expect(store.listRuns()).toHaveLength(1);

    const reloaded = new AutomationStore(path, new Logger("error"));
    await reloaded.load();
    expect(reloaded.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00Z");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("recovers interrupted runs without replaying their claimed occurrence", async () => {
    const { store } = await createStore();
    await store.putAutomation(automation());
    await store.claimRun({
      automationId: "automation-1",
      expectedNextRunAt: "2026-07-21T10:00:00Z",
      nextRunAt: "2026-07-21T11:00:00Z",
      run: runningRun("run-1"),
    });

    const recovered = await store.recoverInterruptedRuns("2026-07-21T10:05:00Z");

    expect(recovered).toHaveLength(1);
    expect(store.getRun("run-1")).toMatchObject({
      status: "interrupted",
      finishedAt: "2026-07-21T10:05:00Z",
    });
    expect(store.getAutomation("automation-1")?.nextRunAt).toBe("2026-07-21T11:00:00Z");
  });

  it("resolves any provider-owned message fragment back to its notification", async () => {
    const { store } = await createStore();
    const notification: AutomationNotification = {
      id: "notification-1",
      automationId: "automation-1",
      runId: "run-1",
      target: { provider: "example", resource: "conversation", id: "room:42" },
      publishedMessages: [
        { provider: "example", resource: "message", id: "room:42:message:7" },
        { provider: "example", resource: "message", id: "room:42:message:8" },
      ],
      sourceThreadId: "codex-thread-1",
      status: "delivered",
      title: "Build monitor",
      body: "A long provider-split result",
      error: null,
      createdAt: "2026-07-21T10:01:00Z",
      updatedAt: "2026-07-21T10:01:00Z",
    };
    await store.putNotification(notification);

    expect(
      store.findNotificationByPublishedMessage({
        provider: "example",
        resource: "message",
        id: "room:42:message:8",
      }),
    ).toEqual(notification);
  });

  it("prevents one provider message from identifying two notifications", async () => {
    const { store } = await createStore();
    const sharedMessage = {
      provider: "example",
      resource: "message" as const,
      id: "room:42:message:7",
    };
    const first: AutomationNotification = {
      id: "notification-1",
      automationId: "automation-1",
      runId: "run-1",
      target: { provider: "example", resource: "conversation", id: "room:42" },
      publishedMessages: [sharedMessage],
      sourceThreadId: "codex-thread-1",
      status: "delivered",
      title: null,
      body: "First",
      error: null,
      createdAt: "2026-07-21T10:01:00Z",
      updatedAt: "2026-07-21T10:01:00Z",
    };
    await store.putNotification(first);

    await expect(
      store.putNotification({
        ...first,
        id: "notification-2",
        runId: "run-2",
        body: "Second",
      }),
    ).rejects.toThrow("already associated");
  });

  it("bounds retained run and notification history per automation", async () => {
    const { store } = await createStore();
    await store.putAutomation(automation());
    for (let index = 0; index < 105; index += 1) {
      const instant = new Date(Date.UTC(2026, 6, 21, 10, index)).toISOString();
      const runId = `run-${String(index).padStart(3, "0")}`;
      await store.putRun({
        ...runningRun(runId),
        status: "succeeded",
        startedAt: instant,
        finishedAt: instant,
        summary: "Completed",
      });
      await store.putNotification({
        id: `notification-${String(index).padStart(3, "0")}`,
        automationId: "automation-1",
        runId,
        target: { provider: "example", resource: "destination", id: "room:42" },
        publishedMessages: [{ provider: "example", resource: "message", id: `message-${index}` }],
        sourceThreadId: `thread-${index}`,
        status: "delivered",
        title: "Status",
        body: "Completed",
        error: null,
        createdAt: instant,
        updatedAt: instant,
      });
    }

    expect(store.listRuns("automation-1")).toHaveLength(100);
    expect(store.listNotifications()).toHaveLength(100);
    expect(store.getRun("run-000")).toBeUndefined();
    expect(
      store.findNotificationByPublishedMessage({
        provider: "example",
        resource: "message",
        id: "message-0",
      }),
    ).toBeUndefined();
    expect(store.getRun("run-104")).toBeDefined();
  });

  it("fails closed instead of forgetting schedules when persisted state is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telex-automations-invalid-"));
    directories.push(directory);
    const path = join(directory, "automations.json");
    await writeFile(path, "{not valid json\n", "utf8");
    const store = new AutomationStore(path, new Logger("error"));

    await expect(store.load()).rejects.toThrow("Could not load automation state");
    await expect(readFile(path, "utf8")).resolves.toBe("{not valid json\n");
  });
});

async function createStore(): Promise<{ path: string; store: AutomationStore }> {
  const directory = await mkdtemp(join(tmpdir(), "telex-automations-"));
  directories.push(directory);
  const path = join(directory, "automations.json");
  const store = new AutomationStore(path, new Logger("error"));
  await store.load();
  return { path, store };
}

function automation(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: "automation-1",
    owner: { provider: "example", resource: "user", id: "user-1" },
    conversation: { provider: "example", resource: "conversation", id: "room-1" },
    deliveryTarget: { provider: "example", resource: "conversation", id: "room-1" },
    kind: "cron",
    name: "Status",
    prompt: "Check the status",
    status: "active",
    schedule: {
      rrule: "FREQ=HOURLY",
      startAt: "2026-07-21T10:00:00Z",
      timeZone: "UTC",
    },
    execution: { mode: "new-thread", cwd: "/workspace" },
    notificationPolicy: "on-result",
    model: null,
    reasoningEffort: null,
    nextRunAt: "2026-07-21T10:00:00Z",
    lastRunAt: null,
    deferredUntil: null,
    deferralReason: null,
    createdAt: "2026-07-21T09:00:00Z",
    updatedAt: "2026-07-21T09:00:00Z",
    revision: 0,
    ...overrides,
  };
}

function runningRun(id: string): AutomationRun {
  return {
    id,
    automationId: "automation-1",
    scheduledFor: "2026-07-21T10:00:00Z",
    status: "running",
    startedAt: "2026-07-21T10:00:00Z",
    finishedAt: null,
    threadId: null,
    summary: null,
    error: null,
  };
}
