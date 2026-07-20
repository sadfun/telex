import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ApplicationContext } from "../codex/rpc.js";
import type {
  CodexDynamicTool,
  CodexDynamicToolContext,
  CodexService,
  CodexTurnResult,
} from "../codex/service.js";
import type {
  DeliveryReceipt,
  MessagingChannel,
  OutboundMessage,
  ProviderReference,
} from "../core/channel.js";
import type { JsonValue } from "../generated/codex/serde_json/JsonValue.js";
import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { nextOccurrence } from "./recurrence.js";
import { AutomationScheduler } from "./scheduler.js";
import type { AutomationStore } from "./store.js";
import type { AutomationDefinition, AutomationNotification, AutomationRun } from "./types.js";

const reasoningEffortSchema = z.string().trim().min(1).max(100).nullable().optional();
const notificationPolicySchema = z.enum(["always", "on-result", "never"]);
const maximumAutomationsPerConversation = 100;
const maximumResultLength = 20_000;
const maximumRunSummaryLength = 4_000;

const viewOperationSchema = z.strictObject({
  mode: z.literal("view"),
  id: z.string().trim().min(1).max(256).optional(),
});

const createOperationSchema = z.strictObject({
  mode: z.literal("create"),
  kind: z.enum(["cron", "heartbeat"]),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  rrule: z.string().trim().min(1).max(4_096),
  time_zone: z.string().trim().min(1).max(128).optional(),
  notification_policy: notificationPolicySchema.optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  reasoning_effort: reasoningEffortSchema,
});

const updateOperationSchema = z.strictObject({
  mode: z.literal("update"),
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  rrule: z.string().trim().min(1).max(4_096).optional(),
  time_zone: z.string().trim().min(1).max(128).optional(),
  status: z.enum(["active", "paused"]).optional(),
  notification_policy: notificationPolicySchema.optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  reasoning_effort: reasoningEffortSchema,
});

const deleteOperationSchema = z.strictObject({
  mode: z.literal("delete"),
  id: z.string().trim().min(1).max(256),
});

const automationOperationSchema = z.discriminatedUnion("mode", [
  viewOperationSchema,
  createOperationSchema,
  updateOperationSchema,
  deleteOperationSchema,
]);

const scheduledResultSchema = z.strictObject({
  notify: z.boolean(),
  title: z.string().trim().max(500),
  message: z.string().trim().max(maximumResultLength),
});

const scheduledResultJsonSchema: JsonValue = {
  type: "object",
  properties: {
    notify: {
      type: "boolean",
      description: "Whether this result is important enough to notify the user.",
    },
    title: { type: "string", maxLength: 500 },
    message: { type: "string", maxLength: maximumResultLength },
  },
  required: ["notify", "title", "message"],
  additionalProperties: false,
};

const automationUpdateSpec = {
  type: "function",
  name: "automation_update",
  description: `Manage Telex scheduled runs. Use this whenever the user asks to schedule, repeat, monitor, remind, follow up later, list schedules, pause, resume, change, or delete a scheduled task. Use kind "heartbeat" to revisit this same Codex thread; use "cron" for a fresh persistent thread on every run. Telex accepts a bounded RFC 5545 RRULE subset: MINUTELY with INTERVAL; HOURLY with optional BYMINUTE; DAILY or WEEKLY with optional BYMINUTE, BYHOUR, and BYDAY; plus UNTIL, and WKST for WEEKLY. Use one line, no DTSTART, and keep BY lists small. Do not invent owners, destinations, or thread IDs: Telex binds them to the current conversation.`,
  inputSchema: {
    type: "object",
    oneOf: [
      {
        properties: {
          mode: { const: "view" },
          id: { type: "string" },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      {
        properties: {
          mode: { const: "create" },
          kind: { enum: ["cron", "heartbeat"] },
          name: { type: "string" },
          prompt: { type: "string" },
          rrule: {
            type: "string",
            description:
              "One bounded RRULE line using FREQ=MINUTELY, HOURLY, DAILY, or WEEKLY; no DTSTART.",
          },
          time_zone: { type: "string" },
          notification_policy: { enum: ["always", "on-result", "never"] },
          model: { type: ["string", "null"] },
          reasoning_effort: { type: ["string", "null"] },
        },
        required: ["mode", "kind", "name", "prompt", "rrule"],
        additionalProperties: false,
      },
      {
        properties: {
          mode: { const: "update" },
          id: { type: "string" },
          name: { type: "string" },
          prompt: { type: "string" },
          rrule: {
            type: "string",
            description:
              "One bounded RRULE line using FREQ=MINUTELY, HOURLY, DAILY, or WEEKLY; no DTSTART.",
          },
          time_zone: { type: "string" },
          status: { enum: ["active", "paused"] },
          notification_policy: { enum: ["always", "on-result", "never"] },
          model: { type: ["string", "null"] },
          reasoning_effort: { type: ["string", "null"] },
        },
        required: ["mode", "id"],
        additionalProperties: false,
      },
      {
        properties: { mode: { const: "delete" }, id: { type: "string" } },
        required: ["mode", "id"],
        additionalProperties: false,
      },
    ],
  },
} as const satisfies CodexDynamicTool["spec"];

export interface ScheduledRunsEngineOptions {
  readonly store: AutomationStore;
  readonly codex: CodexService;
  readonly channels: readonly MessagingChannel[];
  readonly workspace: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export class ScheduledRunsEngine {
  readonly #store: AutomationStore;
  readonly #codex: CodexService;
  readonly #channels: ReadonlyMap<string, MessagingChannel>;
  readonly #workspace: string;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #scheduler: AutomationScheduler;
  #stopping = false;

  public constructor(options: ScheduledRunsEngineOptions) {
    this.#store = options.store;
    this.#codex = options.codex;
    this.#channels = new Map(options.channels.map((channel) => [channel.name, channel]));
    this.#workspace = options.workspace;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#scheduler = new AutomationScheduler({
      store: this.#store,
      logger: this.#logger,
      gate: {
        tryAcquire: async (automation) => {
          const channel = this.#channels.get(automation.owner.provider);
          if (channel === undefined || !(await channel.isAuthorized(automation.owner))) {
            return {
              acquired: false,
              pause: true,
              reason: "The messaging provider no longer authorizes this schedule's owner.",
            };
          }
          const decision = this.#codex.tryAcquireBackground(automation.conversation.id);
          return decision.acquired
            ? { acquired: true, lease: { release: decision.release } }
            : {
                acquired: false,
                reason: decision.reason,
                retryAt: decision.retryAt,
              };
        },
      },
      runner: { run: async (context) => await this.runAutomation(context.automation, context.run) },
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#codex.registerDynamicTool({
      spec: automationUpdateSpec,
      execute: async (argumentsValue, context) => await this.executeTool(argumentsValue, context),
    });
  }

  public async start(): Promise<void> {
    await this.#scheduler.start();
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    const schedulerStopped = this.#scheduler.stop();
    await this.#codex.interruptScheduledTurns();
    await schedulerStopped;
  }

  public listForConversation(
    owner: ProviderReference,
    conversation: ProviderReference,
  ): readonly AutomationDefinition[] {
    return this.#store
      .listAutomations()
      .filter(
        (automation) =>
          automation.status !== "deleted" &&
          sameReference(automation.owner, owner) &&
          sameReference(automation.conversation, conversation),
      );
  }

  public async contextForReply(
    replyTo: ProviderReference | undefined,
    owner: ProviderReference,
    conversation: ProviderReference,
  ): Promise<ApplicationContext | undefined> {
    if (replyTo === undefined) return undefined;
    const notification = this.#store.findNotificationByPublishedMessage(replyTo);
    if (notification === undefined) return undefined;
    const automation = this.#store.getAutomation(notification.automationId);
    if (
      automation === undefined ||
      !sameReference(automation.owner, owner) ||
      !sameReference(automation.conversation, conversation)
    ) {
      return undefined;
    }
    return {
      "telex.scheduled-result": {
        kind: "application",
        value: `The user is replying to a Telex scheduled-run notification. The quoted provider message may be truncated; this is the complete stored result. Do not imply that another Codex thread is the current thread.\n\nAutomation: ${automation.name}\nRun ID: ${notification.runId}\nSource thread: ${notification.sourceThreadId ?? "unavailable"}\nTitle: ${notification.title ?? automation.name}\nResult:\n${notification.body ?? "(no result text)"}`,
      },
    };
  }

  public async continueRun(
    owner: ProviderReference,
    conversation: ProviderReference,
    runId: string,
  ): Promise<Readonly<{ automationName: string; changed: boolean }>> {
    const run = this.#store.getRun(runId);
    if (run === undefined) throw new Error("Scheduled run not found");
    const automation = this.requireAccessibleAutomation(
      run.automationId,
      owner,
      conversation,
      true,
    );
    const sourceThreadId =
      run.threadId ??
      this.#store
        .listNotifications(run.id)
        .find((notification) => notification.sourceThreadId !== null)?.sourceThreadId;
    if (sourceThreadId === undefined || sourceThreadId === null) {
      throw new Error("The scheduled run has no resumable Codex task");
    }
    const changed = await this.#codex.activateConversationThread(conversation.id, sourceThreadId);
    return { automationName: automation.name, changed };
  }

  private async executeTool(
    argumentsValue: unknown,
    context: CodexDynamicToolContext,
  ): Promise<unknown> {
    const operation = automationOperationSchema.parse(argumentsValue);
    const owner = context.owner;
    if (owner === undefined) throw new Error("Scheduled runs require an authenticated user");
    const conversation = conversationReference(context.connector, context.conversationKey);
    switch (operation.mode) {
      case "view": {
        if (operation.id !== undefined) {
          return summarizeAutomation(
            this.requireAccessibleAutomation(operation.id, owner, conversation),
          );
        }
        return {
          automations: this.listForConversation(owner, conversation).map(summarizeAutomation),
        };
      }
      case "create": {
        if (context.deliveryTarget === undefined) {
          throw new Error("This messaging session cannot receive scheduled results");
        }
        const id = stableAutomationId(context.threadId, context.callId);
        const existing = this.#store.getAutomation(id);
        if (existing !== undefined) {
          if (
            !sameReference(existing.owner, owner) ||
            !sameReference(existing.conversation, conversation)
          ) {
            throw new Error("Automation ID collision");
          }
          await this.ensureMemoryFile(existing.id);
          return { created: false, automation: summarizeAutomation(existing) };
        }
        const now = this.currentDate();
        if (
          this.listForConversation(owner, conversation).length >= maximumAutomationsPerConversation
        ) {
          throw new Error(
            `This conversation already has ${maximumAutomationsPerConversation} scheduled runs`,
          );
        }
        const timeZone = operation.time_zone ?? localTimeZone();
        const startAt = new Date(Math.ceil(now.getTime() / 60_000) * 60_000).toISOString();
        const schedule = { rrule: operation.rrule, startAt, timeZone };
        const nextRunAt = nextOccurrence(schedule, now);
        if (nextRunAt === null) throw new Error("The schedule has no future occurrence");
        const automation: AutomationDefinition = {
          id,
          owner,
          conversation,
          deliveryTarget: context.deliveryTarget,
          kind: operation.kind,
          name: operation.name,
          prompt: operation.prompt,
          status: "active",
          schedule,
          execution:
            operation.kind === "heartbeat"
              ? { mode: "existing-thread", threadId: context.threadId }
              : { mode: "new-thread", cwd: this.#workspace },
          notificationPolicy:
            operation.notification_policy ??
            (operation.kind === "heartbeat" ? "on-result" : "always"),
          model: operation.model ?? null,
          reasoningEffort: operation.reasoning_effort ?? null,
          nextRunAt: nextRunAt.toISOString(),
          lastRunAt: null,
          deferredUntil: null,
          deferralReason: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          revision: 0,
        };
        await this.ensureMemoryFile(automation.id);
        await this.#store.putAutomation(automation);
        return { created: true, automation: summarizeAutomation(automation) };
      }
      case "update": {
        this.requireAccessibleAutomation(operation.id, owner, conversation);
        const now = this.currentDate();
        const updated = await this.#store.updateAutomation(operation.id, (current) => {
          if (
            !sameReference(current.owner, owner) ||
            !sameReference(current.conversation, conversation)
          ) {
            throw new Error("Automation not found");
          }
          const schedule = {
            ...current.schedule,
            ...(operation.rrule === undefined ? {} : { rrule: operation.rrule }),
            ...(operation.time_zone === undefined ? {} : { timeZone: operation.time_zone }),
          };
          const status = operation.status ?? current.status;
          const candidateNextRunAt = nextOccurrence(schedule, now)?.toISOString();
          const nextRunAt = status === "paused" ? null : candidateNextRunAt;
          if (status === "active" && nextRunAt === undefined) {
            throw new Error("The updated schedule has no future occurrence");
          }
          return {
            ...current,
            ...(operation.name === undefined ? {} : { name: operation.name }),
            ...(operation.prompt === undefined ? {} : { prompt: operation.prompt }),
            ...(operation.notification_policy === undefined
              ? {}
              : { notificationPolicy: operation.notification_policy }),
            ...(operation.model === undefined ? {} : { model: operation.model }),
            ...(operation.reasoning_effort === undefined
              ? {}
              : { reasoningEffort: operation.reasoning_effort }),
            schedule,
            status,
            nextRunAt: nextRunAt ?? null,
            deferredUntil: null,
            deferralReason: null,
            updatedAt: now.toISOString(),
            revision: current.revision + 1,
          };
        });
        if (updated === undefined) throw new Error("Automation not found");
        return { updated: true, automation: summarizeAutomation(updated) };
      }
      case "delete": {
        this.requireAccessibleAutomation(operation.id, owner, conversation);
        const now = this.currentDate().toISOString();
        await this.#store.updateAutomation(operation.id, (current) => {
          if (
            !sameReference(current.owner, owner) ||
            !sameReference(current.conversation, conversation)
          ) {
            throw new Error("Automation not found");
          }
          return {
            ...current,
            status: "deleted",
            nextRunAt: null,
            deferredUntil: null,
            deferralReason: null,
            updatedAt: now,
            revision: current.revision + 1,
          };
        });
        return { deleted: true, id: operation.id };
      }
    }
  }

  private async runAutomation(
    automation: AutomationDefinition,
    run: AutomationRun,
  ): Promise<Readonly<{ threadId?: string; summary?: string }>> {
    let result: CodexTurnResult | undefined;
    try {
      const memoryPath = await this.ensureMemoryFile(automation.id);
      const prompt = scheduledPrompt(automation, run, memoryPath, this.currentDate());
      result = await this.#codex.runScheduledTurn({
        conversationKey: automation.conversation.id,
        connector: automation.conversation.provider,
        prompt,
        thread:
          automation.execution.mode === "existing-thread"
            ? { mode: "existing", threadId: automation.execution.threadId }
            : {
                mode: "new",
                developerInstructions: scheduledDeveloperInstructions(memoryPath),
              },
        invocation: {
          owner: automation.owner,
          deliveryTarget: automation.deliveryTarget,
          automationId: automation.id,
        },
        ...(automation.model === null ? {} : { model: automation.model }),
        ...(automation.reasoningEffort === null
          ? {}
          : { reasoningEffort: automation.reasoningEffort }),
        outputSchema: scheduledResultJsonSchema,
      });
      const parsed = parseScheduledResult(result.rawText);
      const deliverable = {
        ...parsed,
        message: appendUnavailableAttachmentWarning(parsed.message, result.unavailableAttachments),
      };
      const shouldNotify = notificationDecision(automation, deliverable.notify);
      await this.recordAndMaybeDeliver(
        automation,
        run,
        result.threadId,
        deliverable,
        shouldNotify,
        result.attachments,
      );
      return {
        threadId: result.threadId,
        summary: truncate(deliverable.message, maximumRunSummaryLength),
      };
    } catch (error) {
      if (!this.#stopping) {
        await this.deliverFailure(automation, run, error).catch((deliveryError: unknown) => {
          this.#logger.error("Could not deliver scheduled-run failure", deliveryError, {
            automationId: automation.id,
            runId: run.id,
          });
        });
      }
      throw error;
    } finally {
      await result?.dispose();
    }
  }

  private async recordAndMaybeDeliver(
    automation: AutomationDefinition,
    run: AutomationRun,
    sourceThreadId: string,
    result: z.infer<typeof scheduledResultSchema>,
    shouldNotify: boolean,
    attachments: OutboundMessage["attachments"],
  ): Promise<void> {
    const now = this.currentDate().toISOString();
    const notificationId = crypto.randomUUID();
    const notification: AutomationNotification = {
      id: notificationId,
      automationId: automation.id,
      runId: run.id,
      target: automation.deliveryTarget,
      publishedMessages: [],
      sourceThreadId,
      status: shouldNotify ? "pending" : "suppressed",
      title: result.title || automation.name,
      body: result.message,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.putNotification(notification);
    if (!shouldNotify) return;

    try {
      const receipt = await this.publish(automation.deliveryTarget, {
        text: notificationText(notification.title ?? automation.name, result.message),
        ...(attachments === undefined ? {} : { attachments }),
        actions: [
          {
            label: "Continue this run",
            command: { name: "continue", args: run.id },
          },
        ],
      });
      await this.#store.putNotification({
        ...notification,
        publishedMessages: receipt.publishedMessages,
        status: "delivered",
        updatedAt: this.currentDate().toISOString(),
      });
    } catch (error) {
      await this.#store.putNotification({
        ...notification,
        status: "failed",
        error: errorMessage(error),
        updatedAt: this.currentDate().toISOString(),
      });
      this.#logger.warn("Scheduled result could not be delivered", {
        automationId: automation.id,
        runId: run.id,
        error: errorMessage(error),
      });
    }
  }

  private async deliverFailure(
    automation: AutomationDefinition,
    run: AutomationRun,
    error: unknown,
  ): Promise<void> {
    const now = this.currentDate().toISOString();
    const message = truncate(`Scheduled run failed: ${errorMessage(error)}`, maximumResultLength);
    const notification: AutomationNotification = {
      id: crypto.randomUUID(),
      automationId: automation.id,
      runId: run.id,
      target: automation.deliveryTarget,
      publishedMessages: [],
      sourceThreadId: null,
      status: "pending",
      title: automation.name,
      body: message,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.putNotification(notification);
    try {
      const receipt = await this.publish(automation.deliveryTarget, {
        text: notificationText(automation.name, message),
      });
      await this.#store.putNotification({
        ...notification,
        status: "delivered",
        publishedMessages: receipt.publishedMessages,
        updatedAt: this.currentDate().toISOString(),
      });
    } catch (deliveryError) {
      await this.#store.putNotification({
        ...notification,
        status: "failed",
        error: errorMessage(deliveryError),
        updatedAt: this.currentDate().toISOString(),
      });
      throw deliveryError;
    }
  }

  private async publish(
    target: ProviderReference,
    message: OutboundMessage,
  ): Promise<DeliveryReceipt> {
    const channel = this.#channels.get(target.provider);
    if (channel === undefined) throw new Error(`No messaging provider for ${target.provider}`);
    return await channel.publish(target, message);
  }

  private requireAccessibleAutomation(
    id: string,
    owner: ProviderReference,
    conversation: ProviderReference,
    includeDeleted = false,
  ): AutomationDefinition {
    const automation = this.#store.getAutomation(id);
    if (
      automation === undefined ||
      (!includeDeleted && automation.status === "deleted") ||
      !sameReference(automation.owner, owner) ||
      !sameReference(automation.conversation, conversation)
    ) {
      throw new Error("Automation not found");
    }
    return automation;
  }

  private async ensureMemoryFile(automationId: string): Promise<string> {
    const directory = join(this.#workspace, ".telex", "automations", automationId);
    const path = join(directory, "memory.md");
    await mkdir(directory, { recursive: true });
    try {
      await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(path, "# Automation memory\n\n", { encoding: "utf8", mode: 0o600 });
    }
    return path;
  }

  private currentDate(): Date {
    const date = this.#now();
    if (!Number.isFinite(date.getTime()))
      throw new Error("Automation clock returned an invalid date");
    return date;
  }
}

function stableAutomationId(threadId: string, callId: string): string {
  const value = createHash("sha256").update(threadId).update("\0").update(callId).digest("hex");
  return `auto_${value.slice(0, 32)}`;
}

function sameReference(left: ProviderReference, right: ProviderReference): boolean {
  return (
    left.provider === right.provider && left.resource === right.resource && left.id === right.id
  );
}

function conversationReference(provider: string, id: string): ProviderReference {
  return { provider, resource: "conversation", id };
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function notificationDecision(automation: AutomationDefinition, modelDecision: boolean): boolean {
  if (automation.notificationPolicy === "always") return true;
  if (automation.notificationPolicy === "never") return false;
  return modelDecision;
}

function parseScheduledResult(text: string): z.infer<typeof scheduledResultSchema> {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    return scheduledResultSchema.parse(JSON.parse(unfenced));
  } catch {
    return {
      // Suppression must be an explicit, schema-valid model decision. A malformed
      // result is surfaced rather than silently hiding a potentially important heartbeat.
      notify: true,
      title: "",
      message: truncate(
        trimmed || "Scheduled run completed without a result.",
        maximumResultLength,
      ),
    };
  }
}

function summarizeAutomation(automation: AutomationDefinition): unknown {
  return {
    id: automation.id,
    kind: automation.kind,
    name: automation.name,
    prompt: automation.prompt,
    status: automation.status,
    rrule: automation.schedule.rrule,
    time_zone: automation.schedule.timeZone,
    next_run_at: automation.nextRunAt,
    last_run_at: automation.lastRunAt,
    notification_policy: automation.notificationPolicy,
    model: automation.model,
    reasoning_effort: automation.reasoningEffort,
  };
}

function scheduledPrompt(
  automation: AutomationDefinition,
  run: AutomationRun,
  memoryPath: string,
  now: Date,
): string {
  const envelope = automation.kind === "heartbeat" ? "heartbeat" : "scheduled_run";
  return `<${envelope}>
<automation_id>${automation.id}</automation_id>
<run_id>${run.id}</run_id>
<name>${escapeXml(automation.name)}</name>
<scheduled_for>${run.scheduledFor}</scheduled_for>
<current_time_iso>${now.toISOString()}</current_time_iso>
<memory_path>${escapeXml(memoryPath)}</memory_path>
<instructions>
${automation.prompt}
</instructions>

Read the memory file before doing the work. Update it with concise durable context before finishing. This is an unattended run: do not ask the user questions or wait for approval. Return the required structured result. Set notify=false when a heartbeat found nothing worth interrupting the user about. Never claim that a suppressed result was shown to the user.
</${envelope}>`;
}

function scheduledDeveloperInstructions(memoryPath: string): string {
  return `You are running an unattended Telex scheduled task, following the Codex Desktop automation model. Read ${memoryPath} before each run and update it with concise durable context before finishing. Do not ask the user questions or wait for interactive approval. Your final response must follow the supplied output schema.`;
}

function notificationText(title: string, message: string): string {
  return `⏱ ${title}\n\n${message}\n\nReply to this message to discuss it in your current task.`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : value.slice(0, length);
}

function appendUnavailableAttachmentWarning(
  message: string,
  unavailable: readonly string[],
): string {
  if (unavailable.length === 0) return message;
  const warning = `Could not attach ${unavailable.join(", ")}.`;
  return truncate(message.length === 0 ? warning : `${warning}\n\n${message}`, maximumResultLength);
}
