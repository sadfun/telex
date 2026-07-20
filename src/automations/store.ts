import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteJson, ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";
import {
  type AutomationDefinition,
  type AutomationNotification,
  type AutomationRun,
  type AutomationRunCompletion,
  automationDefinitionSchema,
  automationNotificationSchema,
  automationRunSchema,
  instantSchema,
  type ProviderReference,
} from "./types.js";

const storedStateSchema = z.strictObject({
  version: z.literal(1),
  automations: z.record(z.string(), automationDefinitionSchema),
  runs: z.record(z.string(), automationRunSchema),
  notifications: z.record(z.string(), automationNotificationSchema),
});

type StoredState = z.infer<typeof storedStateSchema>;
const maximumRunsPerAutomation = 100;
const maximumNotificationsPerAutomation = 100;

export interface AutomationRunClaim {
  readonly automationId: string;
  readonly expectedNextRunAt: string;
  readonly nextRunAt: string | null;
  readonly run: AutomationRun;
}

export interface AutomationDeferral {
  readonly automationId: string;
  readonly expectedNextRunAt: string;
  readonly retryAt: string;
  readonly reason: string;
  readonly updatedAt: string;
}

function emptyState(): StoredState {
  return { version: 1, automations: {}, runs: {}, notifications: {} };
}

export class AutomationStore {
  readonly #path: string;
  readonly #logger: Logger;
  #state: StoredState = emptyState();
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(path: string, logger: Logger) {
    this.#path = path;
    this.#logger = logger;
  }

  public async load(): Promise<void> {
    await ensureDirectory(dirname(this.#path));
    try {
      this.#state = storedStateSchema.parse(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#state = emptyState();
        return;
      }
      this.#logger.error("Could not load automation state", error, { path: this.#path });
      throw new Error(`Could not load automation state at ${this.#path}`, { cause: error });
    }
  }

  public getAutomation(id: string): AutomationDefinition | undefined {
    return clone(this.#state.automations[id]);
  }

  public listAutomations(): AutomationDefinition[] {
    return Object.values(this.#state.automations)
      .map((automation) => clone(automation))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public listDueAutomations(at: string): AutomationDefinition[] {
    const timestamp = parseInstant(at, "at");
    return Object.values(this.#state.automations)
      .filter((automation) => {
        if (automation.status !== "active" || automation.nextRunAt === null) return false;
        if (Date.parse(automation.nextRunAt) > timestamp) return false;
        return (
          automation.deferredUntil === null || Date.parse(automation.deferredUntil) <= timestamp
        );
      })
      .map((automation) => clone(automation))
      .sort((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? ""));
  }

  public async putAutomation(automation: AutomationDefinition): Promise<AutomationDefinition> {
    const validated = automationDefinitionSchema.parse(automation);
    return await this.write((draft) => {
      draft.automations[validated.id] = validated;
      return validated;
    });
  }

  public async updateAutomation(
    id: string,
    update: (current: AutomationDefinition) => AutomationDefinition,
  ): Promise<AutomationDefinition | undefined> {
    return await this.write((draft) => {
      const current = draft.automations[id];
      if (current === undefined) return undefined;
      const updated = automationDefinitionSchema.parse(update(clone(current)));
      if (updated.id !== id) throw new Error("An automation update cannot change its id");
      draft.automations[id] = updated;
      return updated;
    });
  }

  public async deleteAutomation(id: string): Promise<boolean> {
    return await this.write((draft) => {
      if (draft.automations[id] === undefined) return false;
      delete draft.automations[id];
      return true;
    });
  }

  /** Atomically advances a schedule and creates its running record. */
  public async claimRun(claim: AutomationRunClaim): Promise<boolean> {
    instantSchema.parse(claim.expectedNextRunAt);
    if (claim.nextRunAt !== null) instantSchema.parse(claim.nextRunAt);
    const run = automationRunSchema.parse(claim.run);
    if (run.status !== "running" || run.automationId !== claim.automationId) {
      throw new Error("A claimed run must be running and belong to the claimed automation");
    }

    return await this.write((draft) => {
      const automation = draft.automations[claim.automationId];
      if (
        automation === undefined ||
        automation.status !== "active" ||
        automation.nextRunAt !== claim.expectedNextRunAt ||
        draft.runs[run.id] !== undefined
      ) {
        return false;
      }

      draft.automations[automation.id] = automationDefinitionSchema.parse({
        ...automation,
        status: claim.nextRunAt === null ? "paused" : automation.status,
        nextRunAt: claim.nextRunAt,
        lastRunAt: run.startedAt,
        deferredUntil: null,
        deferralReason: null,
        updatedAt: run.startedAt,
        revision: automation.revision + 1,
      });
      draft.runs[run.id] = run;
      pruneAutomationHistory(draft, automation.id);
      return true;
    });
  }

  public async deferAutomation(deferral: AutomationDeferral): Promise<boolean> {
    instantSchema.parse(deferral.retryAt);
    instantSchema.parse(deferral.updatedAt);
    return await this.write((draft) => {
      const automation = draft.automations[deferral.automationId];
      if (
        automation === undefined ||
        automation.status !== "active" ||
        automation.nextRunAt !== deferral.expectedNextRunAt
      ) {
        return false;
      }
      draft.automations[automation.id] = automationDefinitionSchema.parse({
        ...automation,
        deferredUntil: deferral.retryAt,
        deferralReason: deferral.reason,
        updatedAt: deferral.updatedAt,
        revision: automation.revision + 1,
      });
      return true;
    });
  }

  public getRun(id: string): AutomationRun | undefined {
    return clone(this.#state.runs[id]);
  }

  public listRuns(automationId?: string): AutomationRun[] {
    return Object.values(this.#state.runs)
      .filter((run) => automationId === undefined || run.automationId === automationId)
      .map((run) => clone(run))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public async putRun(run: AutomationRun): Promise<AutomationRun> {
    const validated = automationRunSchema.parse(run);
    return await this.write((draft) => {
      draft.runs[validated.id] = validated;
      pruneAutomationHistory(draft, validated.automationId);
      return validated;
    });
  }

  public async completeRun(id: string, completion: AutomationRunCompletion): Promise<boolean> {
    instantSchema.parse(completion.finishedAt);
    return await this.write((draft) => {
      const run = draft.runs[id];
      if (run === undefined || run.status !== "running") return false;
      draft.runs[id] = automationRunSchema.parse({
        ...run,
        status: completion.status,
        finishedAt: completion.finishedAt,
        threadId: completion.threadId ?? run.threadId,
        summary: completion.summary ?? run.summary,
        error: completion.error ?? null,
      });
      pruneAutomationHistory(draft, run.automationId);
      return true;
    });
  }

  public async recoverInterruptedRuns(at: string): Promise<AutomationRun[]> {
    instantSchema.parse(at);
    return await this.write((draft) => {
      const recovered: AutomationRun[] = [];
      for (const [id, run] of Object.entries(draft.runs)) {
        if (run.status !== "running") continue;
        const interrupted = automationRunSchema.parse({
          ...run,
          status: "interrupted",
          finishedAt: at,
          error: "Telex restarted before the scheduled run completed.",
        });
        draft.runs[id] = interrupted;
        recovered.push(interrupted);
      }
      return recovered;
    });
  }

  public async recoverPendingNotifications(at: string): Promise<AutomationNotification[]> {
    instantSchema.parse(at);
    return await this.write((draft) => {
      const recovered: AutomationNotification[] = [];
      for (const [id, notification] of Object.entries(draft.notifications)) {
        if (notification.status !== "pending") continue;
        const failed = automationNotificationSchema.parse({
          ...notification,
          status: "failed",
          error: "Telex restarted before notification delivery was confirmed.",
          updatedAt: at,
        });
        draft.notifications[id] = failed;
        recovered.push(failed);
      }
      return recovered;
    });
  }

  public getNotification(id: string): AutomationNotification | undefined {
    return clone(this.#state.notifications[id]);
  }

  public listNotifications(runId?: string): AutomationNotification[] {
    return Object.values(this.#state.notifications)
      .filter((notification) => runId === undefined || notification.runId === runId)
      .map((notification) => clone(notification))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public findNotificationByPublishedMessage(
    reference: ProviderReference,
  ): AutomationNotification | undefined {
    const notification = Object.values(this.#state.notifications).find((candidate) =>
      candidate.publishedMessages.some(
        (message) =>
          message.provider === reference.provider &&
          message.resource === reference.resource &&
          message.id === reference.id,
      ),
    );
    return clone(notification);
  }

  public async putNotification(
    notification: AutomationNotification,
  ): Promise<AutomationNotification> {
    const validated = automationNotificationSchema.parse(notification);
    return await this.write((draft) => {
      for (const message of validated.publishedMessages) {
        const owner = Object.values(draft.notifications).find(
          (candidate) =>
            candidate.id !== validated.id &&
            candidate.publishedMessages.some((existing) => sameReference(existing, message)),
        );
        if (owner !== undefined) {
          throw new Error(`Published message is already associated with notification ${owner.id}`);
        }
      }
      draft.notifications[validated.id] = validated;
      pruneAutomationHistory(draft, validated.automationId);
      return validated;
    });
  }

  private async write<T>(operation: (draft: StoredState) => T): Promise<T> {
    const pending = this.#writeTail
      .catch(() => undefined)
      .then(async () => {
        const draft = clone(this.#state);
        const result = operation(draft);
        await atomicWriteJson(this.#path, draft);
        this.#state = draft;
        return clone(result);
      });
    this.#writeTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseInstant(value: string, field: string): number {
  if (!instantSchema.safeParse(value).success) throw new Error(`${field} must be an ISO instant`);
  return Date.parse(value);
}

function sameReference(left: ProviderReference, right: ProviderReference): boolean {
  return (
    left.provider === right.provider && left.resource === right.resource && left.id === right.id
  );
}

function pruneAutomationHistory(draft: StoredState, automationId: string): void {
  const runs = Object.values(draft.runs)
    .filter((run) => run.automationId === automationId)
    .sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id),
    );
  const keptRunIds = new Set<string>();
  for (const run of runs) {
    if (run.status === "running" || keptRunIds.size < maximumRunsPerAutomation) {
      keptRunIds.add(run.id);
    }
  }
  for (const run of runs) {
    if (keptRunIds.has(run.id)) continue;
    delete draft.runs[run.id];
    for (const [notificationId, notification] of Object.entries(draft.notifications)) {
      if (notification.runId === run.id) delete draft.notifications[notificationId];
    }
  }

  const notifications = Object.values(draft.notifications)
    .filter((notification) => notification.automationId === automationId)
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
  for (const notification of notifications.slice(maximumNotificationsPerAutomation)) {
    delete draft.notifications[notification.id];
  }
}
