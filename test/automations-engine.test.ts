import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledRunsEngine } from "../src/automations/engine.js";
import { AutomationStore } from "../src/automations/store.js";
import type { AutomationDefinition } from "../src/automations/types.js";
import type {
  CodexDynamicTool,
  CodexDynamicToolContext,
  CodexService,
  ScheduledTurnRequest,
} from "../src/codex/service.js";
import type {
  DeliveryReceipt,
  MessageHandler,
  MessagingChannel,
  OutboundMessage,
  ProviderReference,
} from "../src/core/channel.js";
import { Logger } from "../src/shared/logger.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("ScheduledRunsEngine", () => {
  it("binds model-created schedules to server-derived provider context", async () => {
    const fixture = await createFixture();
    const context = toolContext();
    const operation = {
      mode: "create",
      kind: "heartbeat",
      name: "Build monitor",
      prompt: "Check whether the build is healthy.",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      time_zone: "UTC",
    } as const;

    const first = await fixture.codex.tool?.execute(operation, context);
    const second = await fixture.codex.tool?.execute(operation, context);
    const automations = fixture.store.listAutomations();

    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({ created: false });
    expect(automations).toHaveLength(1);
    expect(automations[0]).toMatchObject({
      owner: context.owner,
      conversation: { provider: "telegram", resource: "conversation", id: "telegram:42:0" },
      deliveryTarget: context.deliveryTarget,
      kind: "heartbeat",
      execution: { mode: "existing-thread", threadId: "thread-current" },
      nextRunAt: "2026-07-21T09:00:00.000Z",
    });

    const automationId = automations[0]?.id;
    if (automationId === undefined) throw new Error("Expected an automation");
    await expect(
      readFile(join(fixture.workspace, ".telex", "automations", automationId, "memory.md"), "utf8"),
    ).resolves.toContain("# Automation memory");
    const otherConversation = { ...context, conversationKey: "telegram:99:0" };
    await expect(
      fixture.codex.tool?.execute({ mode: "view", id: automationId }, otherConversation),
    ).rejects.toThrow("Automation not found");
    await expect(
      fixture.codex.tool?.execute({ mode: "delete", id: automationId }, otherConversation),
    ).rejects.toThrow("Automation not found");
    const { deliveryTarget: _deliveryTarget, ...withoutDelivery } = context;
    await expect(fixture.codex.tool?.execute(operation, withoutDelivery)).rejects.toThrow(
      "cannot receive scheduled results",
    );
  });

  it("runs a due cron in a detached thread and records every provider message", async () => {
    const fixture = await createFixture();
    await fixture.store.putAutomation(dueAutomation());
    fixture.codex.backgroundResult = JSON.stringify({
      notify: true,
      title: "Build failed",
      message: "The migration step failed.",
    });
    fixture.codex.unavailableAttachments = ["migration.log"];

    await fixture.engine.start();
    await vi.waitFor(() => {
      expect(fixture.store.listRuns()[0]?.status).toBe("succeeded");
    });
    await fixture.engine.stop();

    expect(fixture.codex.scheduledRequests).toHaveLength(1);
    expect(fixture.codex.scheduledRequests[0]).toMatchObject({
      conversationKey: "telegram:42:0",
      thread: { mode: "new" },
      invocation: {
        owner: ownerReference,
        deliveryTarget,
        automationId: "automation-1",
      },
    });
    expect(fixture.channel.publish).toHaveBeenCalledOnce();
    const outbound = fixture.channel.publish.mock.calls[0]?.[1];
    expect(outbound?.text).toContain("Build failed");
    expect(outbound?.text).toContain("Could not attach migration.log.");
    expect(outbound?.text).not.toContain('"notify":true');
    expect(outbound?.actions?.[0]?.command).toEqual({
      name: "continue",
      args: expect.any(String),
    });
    const notification = fixture.store.listNotifications()[0];
    expect(notification).toMatchObject({
      status: "delivered",
      sourceThreadId: "thread-scheduled",
      publishedMessages: [messageReference("101"), messageReference("102")],
    });

    const context = await fixture.engine.contextForReply(
      messageReference("102"),
      ownerReference,
      conversationReference,
    );
    expect(context?.["telex.scheduled-result"]?.value).toContain("The migration step failed.");
    const runId = fixture.store.listRuns()[0]?.id;
    expect(runId).toBeDefined();
    const continued = await fixture.engine.continueRun(
      ownerReference,
      conversationReference,
      runId as string,
    );
    expect(continued).toEqual({ automationName: "Build monitor", changed: true });
    expect(fixture.codex.activateConversationThread).toHaveBeenCalledWith(
      "telegram:42:0",
      "thread-scheduled",
    );
  });

  it("suppresses an uneventful heartbeat without publishing it", async () => {
    const fixture = await createFixture();
    await fixture.store.putAutomation({
      ...dueAutomation(),
      id: "heartbeat-1",
      kind: "heartbeat",
      execution: { mode: "existing-thread", threadId: "thread-current" },
      notificationPolicy: "on-result",
    });
    fixture.codex.backgroundResult = JSON.stringify({
      notify: false,
      title: "No change",
      message: "Everything is still healthy.",
    });

    await fixture.engine.start();
    await vi.waitFor(() => {
      expect(fixture.store.listRuns()[0]?.status).toBe("succeeded");
    });
    await fixture.engine.stop();

    expect(fixture.channel.publish).not.toHaveBeenCalled();
    expect(fixture.store.listNotifications()[0]?.status).toBe("suppressed");
  });

  it("can continue from a persisted notification before run finalization", async () => {
    const fixture = await createFixture();
    await fixture.store.putAutomation(dueAutomation());
    await fixture.store.putRun({
      id: "run-pending",
      automationId: "automation-1",
      scheduledFor: "2026-07-21T08:00:00.000Z",
      status: "running",
      startedAt: "2026-07-21T08:30:00.000Z",
      finishedAt: null,
      threadId: null,
      summary: null,
      error: null,
    });
    await fixture.store.putNotification({
      id: "notification-pending",
      automationId: "automation-1",
      runId: "run-pending",
      target: deliveryTarget,
      publishedMessages: [],
      sourceThreadId: "thread-persisted-before-delivery",
      status: "pending",
      title: "Build monitor",
      body: "A result",
      error: null,
      createdAt: "2026-07-21T08:31:00.000Z",
      updatedAt: "2026-07-21T08:31:00.000Z",
    });

    await expect(
      fixture.engine.continueRun(ownerReference, conversationReference, "run-pending"),
    ).resolves.toEqual({ automationName: "Build monitor", changed: true });
    expect(fixture.codex.activateConversationThread).toHaveBeenCalledWith(
      "telegram:42:0",
      "thread-persisted-before-delivery",
    );
  });

  it("pauses persisted schedules whose provider owner is no longer authorized", async () => {
    const fixture = await createFixture();
    await fixture.store.putAutomation(dueAutomation());
    fixture.channel.authorized = false;

    await fixture.engine.start();
    await vi.waitFor(() => {
      expect(fixture.store.getAutomation("automation-1")).toMatchObject({
        status: "paused",
        nextRunAt: null,
        deferralReason: "The messaging provider no longer authorizes this schedule's owner.",
      });
    });
    await fixture.engine.stop();

    expect(fixture.codex.scheduledRequests).toHaveLength(0);
    expect(fixture.channel.publish).not.toHaveBeenCalled();
  });
});

class FakeCodex {
  public tool: CodexDynamicTool | undefined;
  public backgroundResult = "";
  public readonly scheduledRequests: ScheduledTurnRequest[] = [];
  public readonly activateConversationThread = vi.fn(async () => true);
  public readonly interruptScheduledTurns = vi.fn(async () => undefined);
  public unavailableAttachments: readonly string[] = [];

  public registerDynamicTool(tool: CodexDynamicTool): void {
    this.tool = tool;
  }

  public tryAcquireBackground(): ReturnType<CodexService["tryAcquireBackground"]> {
    return { acquired: true, release: () => undefined };
  }

  public async runScheduledTurn(request: ScheduledTurnRequest) {
    this.scheduledRequests.push(request);
    return {
      threadId: "thread-scheduled",
      turnId: "turn-scheduled",
      rawText: this.backgroundResult,
      text:
        this.unavailableAttachments.length === 0
          ? this.backgroundResult
          : `Could not attach ${this.unavailableAttachments.join(", ")}.\n\n${this.backgroundResult}`,
      attachments: [],
      unavailableAttachments: this.unavailableAttachments,
      dispose: vi.fn(async () => undefined),
    };
  }
}

class FakeChannel implements MessagingChannel {
  public readonly name = "telegram";
  public readonly publish = vi.fn(
    async (_target: ProviderReference, _message: OutboundMessage): Promise<DeliveryReceipt> => ({
      publishedMessages: [messageReference("101"), messageReference("102")],
    }),
  );
  public authorized = true;

  public isAuthorized(_principal: ProviderReference): boolean {
    return this.authorized;
  }

  public async start(_handler: MessageHandler): Promise<void> {}
  public async stop(): Promise<void> {}
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "telex-automation-engine-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = new AutomationStore(join(directory, "automations.json"), new Logger("error"));
  await store.load();
  const codex = new FakeCodex();
  const channel = new FakeChannel();
  const engine = new ScheduledRunsEngine({
    store,
    codex: codex as unknown as CodexService,
    channels: [channel],
    workspace,
    logger: new Logger("error"),
    now: () => new Date("2026-07-21T08:30:00.000Z"),
  });
  return { store, codex, channel, engine, workspace };
}

const ownerReference: ProviderReference = {
  provider: "telegram",
  resource: "user",
  id: "7",
};

const deliveryTarget: ProviderReference = {
  provider: "telegram",
  resource: "destination",
  id: "opaque-target",
};

const conversationReference: ProviderReference = {
  provider: "telegram",
  resource: "conversation",
  id: "telegram:42:0",
};

function messageReference(id: string): ProviderReference {
  return { provider: "telegram", resource: "message", id };
}

function toolContext(): CodexDynamicToolContext {
  return {
    conversationKey: "telegram:42:0",
    connector: "telegram",
    threadId: "thread-current",
    turnId: "turn-current",
    callId: "call-create-1",
    owner: ownerReference,
    deliveryTarget,
  };
}

function dueAutomation(): AutomationDefinition {
  return {
    id: "automation-1",
    owner: ownerReference,
    conversation: {
      provider: "telegram",
      resource: "conversation",
      id: "telegram:42:0",
    },
    deliveryTarget,
    kind: "cron",
    name: "Build monitor",
    prompt: "Check the build.",
    status: "active",
    schedule: {
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      startAt: "2026-07-20T09:00:00.000Z",
      timeZone: "UTC",
    },
    execution: { mode: "new-thread", cwd: "/workspace" },
    notificationPolicy: "always",
    model: null,
    reasoningEffort: null,
    nextRunAt: "2026-07-21T08:00:00.000Z",
    lastRunAt: null,
    deferredUntil: null,
    deferralReason: null,
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:00:00.000Z",
    revision: 0,
  };
}
