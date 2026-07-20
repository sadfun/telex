import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { nextOccurrence } from "./recurrence.js";
import type { AutomationStore } from "./store.js";
import type { AutomationDefinition, AutomationRun } from "./types.js";

export interface AutomationExecutionLease {
  readonly release: () => void | Promise<void>;
}

export type AutomationGateDecision =
  | { readonly acquired: true; readonly lease: AutomationExecutionLease }
  | {
      readonly acquired: false;
      readonly reason?: string;
      readonly retryAt?: Date;
      readonly pause?: boolean;
    };

/**
 * The bridge owns foreground priority. A provider can deny this non-blocking
 * acquisition while a user turn is running or queued.
 */
export interface AutomationExecutionGate {
  readonly tryAcquire: (
    automation: AutomationDefinition,
  ) => AutomationGateDecision | Promise<AutomationGateDecision>;
}

export interface AutomationRunnerResult {
  readonly threadId?: string;
  readonly summary?: string;
}

export interface AutomationRunnerContext {
  readonly automation: AutomationDefinition;
  readonly run: AutomationRun;
}

export interface AutomationRunner {
  readonly run: (
    context: AutomationRunnerContext,
  ) => AutomationRunnerResult | Promise<AutomationRunnerResult>;
}

export interface AutomationSchedulerOptions {
  readonly store: AutomationStore;
  readonly runner: AutomationRunner;
  readonly logger: Logger;
  readonly gate?: AutomationExecutionGate;
  readonly pollIntervalMs?: number;
  readonly deferralMs?: number;
  readonly maxConcurrency?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

const openGate: AutomationExecutionGate = {
  tryAcquire: () => ({ acquired: true, lease: { release: () => undefined } }),
};

export class AutomationScheduler {
  readonly #store: AutomationStore;
  readonly #runner: AutomationRunner;
  readonly #logger: Logger;
  readonly #gate: AutomationExecutionGate;
  readonly #pollIntervalMs: number;
  readonly #deferralMs: number;
  readonly #maxConcurrency: number;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #inFlight = new Map<string, Promise<void>>();
  #timer: NodeJS.Timeout | undefined;
  #tickInProgress: Promise<void> | undefined;
  #initialized = false;
  #stopping = false;

  public constructor(options: AutomationSchedulerOptions) {
    this.#store = options.store;
    this.#runner = options.runner;
    this.#logger = options.logger;
    this.#gate = options.gate ?? openGate;
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 30_000, "pollIntervalMs");
    this.#deferralMs = positiveInteger(options.deferralMs ?? 30_000, "deferralMs");
    this.#maxConcurrency = positiveInteger(options.maxConcurrency ?? 3, "maxConcurrency");
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  public get activeCount(): number {
    return this.#inFlight.size;
  }

  public async start(): Promise<void> {
    if (this.#timer !== undefined) return;
    if (this.#stopping) throw new Error("Cannot restart a stopped automation scheduler");
    await this.initialize();
    await this.tick();
    this.#timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.#logger.error("Automation scheduler tick failed", error);
      });
    }, this.#pollIntervalMs);
    this.#timer.unref();
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    const recoveredAt = this.currentInstant();
    const recovered = await this.#store.recoverInterruptedRuns(recoveredAt);
    if (recovered.length > 0) {
      this.#logger.warn("Recovered interrupted scheduled runs", { count: recovered.length });
    }
    const pendingNotifications = await this.#store.recoverPendingNotifications(recoveredAt);
    if (pendingNotifications.length > 0) {
      this.#logger.warn("Marked unconfirmed scheduled notifications as failed", {
        count: pendingNotifications.length,
      });
    }
    this.#initialized = true;
  }

  /** Claims and launches due work; completion continues asynchronously. */
  public async tick(): Promise<void> {
    if (this.#stopping) return;
    await this.initialize();
    if (this.#tickInProgress !== undefined) return await this.#tickInProgress;
    const operation = this.runTick();
    this.#tickInProgress = operation;
    try {
      await operation;
    } finally {
      if (this.#tickInProgress === operation) this.#tickInProgress = undefined;
    }
  }

  public async waitForIdle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight.values()]);
    }
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#tickInProgress !== undefined) await this.#tickInProgress;
    await this.waitForIdle();
  }

  private async runTick(): Promise<void> {
    const now = this.currentDate();
    let capacity = this.#maxConcurrency - this.#inFlight.size;
    if (capacity <= 0) return;

    const due = this.#store.listDueAutomations(now.toISOString());
    for (const automation of due) {
      if (capacity <= 0) break;
      if (this.#inFlight.has(automation.id) || automation.nextRunAt === null) continue;

      const decision = await this.acquire(automation, now);
      if (!decision.acquired) {
        if (decision.pause === true) {
          await this.pauseDeniedAutomation(
            automation,
            now,
            decision.reason ?? "The scheduled run is no longer authorized.",
          );
          continue;
        }
        const retryAt = validRetryAt(decision.retryAt, now, this.#deferralMs);
        await this.#store.deferAutomation({
          automationId: automation.id,
          expectedNextRunAt: automation.nextRunAt,
          retryAt: retryAt.toISOString(),
          reason: decision.reason ?? "A foreground conversation has priority.",
          updatedAt: now.toISOString(),
        });
        continue;
      }

      let nextRunAt: Date | null;
      try {
        // Calculating from now deliberately coalesces all missed occurrences.
        nextRunAt = nextOccurrence(automation.schedule, now);
      } catch (error) {
        await release(decision.lease, this.#logger);
        await this.pauseInvalidSchedule(automation, now, error);
        continue;
      }

      const run: AutomationRun = {
        id: this.#createId(),
        automationId: automation.id,
        scheduledFor: automation.nextRunAt,
        status: "running",
        startedAt: now.toISOString(),
        finishedAt: null,
        threadId: null,
        summary: null,
        error: null,
      };
      const claimed = await this.#store.claimRun({
        automationId: automation.id,
        expectedNextRunAt: automation.nextRunAt,
        nextRunAt: nextRunAt?.toISOString() ?? null,
        run,
      });
      if (!claimed) {
        await release(decision.lease, this.#logger);
        continue;
      }

      this.launch(automation, run, decision.lease);
      capacity -= 1;
    }
  }

  private async acquire(
    automation: AutomationDefinition,
    now: Date,
  ): Promise<AutomationGateDecision> {
    try {
      return await this.#gate.tryAcquire(automation);
    } catch (error) {
      this.#logger.warn("Could not acquire a scheduled-run conversation lease", {
        automationId: automation.id,
        error: errorMessage(error),
      });
      return {
        acquired: false,
        reason: "The conversation lane could not be acquired.",
        retryAt: new Date(now.getTime() + this.#deferralMs),
      };
    }
  }

  private launch(
    automation: AutomationDefinition,
    run: AutomationRun,
    lease: AutomationExecutionLease,
  ): void {
    const execution = this.execute(automation, run, lease);
    this.#inFlight.set(automation.id, execution);
    void execution
      .finally(() => {
        if (this.#inFlight.get(automation.id) === execution) this.#inFlight.delete(automation.id);
      })
      .catch((error: unknown) => {
        this.#logger.error("Scheduled-run finalization failed", error, {
          automationId: automation.id,
          runId: run.id,
        });
      });
  }

  private async execute(
    automation: AutomationDefinition,
    run: AutomationRun,
    lease: AutomationExecutionLease,
  ): Promise<void> {
    let completion:
      | {
          readonly status: "succeeded";
          readonly threadId?: string;
          readonly summary?: string;
        }
      | { readonly status: "failed" | "interrupted"; readonly error: string };
    try {
      const result = await this.#runner.run({ automation, run });
      completion = {
        status: "succeeded",
        ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
        ...(result.summary === undefined ? {} : { summary: result.summary }),
      };
    } catch (error) {
      completion = {
        status: this.#stopping ? "interrupted" : "failed",
        error: this.#stopping
          ? "Telex stopped before the scheduled run completed."
          : errorMessage(error),
      };
      if (!this.#stopping) {
        this.#logger.error("Scheduled run failed", error, {
          automationId: automation.id,
          runId: run.id,
        });
      }
    }

    try {
      await this.#store.completeRun(run.id, {
        ...completion,
        finishedAt: this.currentInstant(),
      });
    } catch (error) {
      this.#logger.error("Could not persist scheduled-run completion", error, {
        automationId: automation.id,
        runId: run.id,
      });
    } finally {
      await release(lease, this.#logger);
    }
  }

  private async pauseInvalidSchedule(
    automation: AutomationDefinition,
    now: Date,
    error: unknown,
  ): Promise<void> {
    const message = `Invalid recurrence: ${errorMessage(error)}`;
    await this.#store.updateAutomation(automation.id, (current) => {
      if (current.revision !== automation.revision || current.nextRunAt !== automation.nextRunAt) {
        return current;
      }
      return {
        ...current,
        status: "paused",
        deferredUntil: null,
        deferralReason: message,
        updatedAt: now.toISOString(),
        revision: current.revision + 1,
      };
    });
    this.#logger.error("Paused automation with an invalid schedule", error, {
      automationId: automation.id,
    });
  }

  private async pauseDeniedAutomation(
    automation: AutomationDefinition,
    now: Date,
    reason: string,
  ): Promise<void> {
    await this.#store.updateAutomation(automation.id, (current) => {
      if (current.revision !== automation.revision || current.nextRunAt !== automation.nextRunAt) {
        return current;
      }
      return {
        ...current,
        status: "paused",
        nextRunAt: null,
        deferredUntil: null,
        deferralReason: reason,
        updatedAt: now.toISOString(),
        revision: current.revision + 1,
      };
    });
    this.#logger.warn("Paused an unauthorized scheduled run", {
      automationId: automation.id,
      reason,
    });
  }

  private currentDate(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime()))
      throw new Error("Scheduler clock returned an invalid date");
    return now;
  }

  private currentInstant(): string {
    return this.currentDate().toISOString();
  }
}

async function release(lease: AutomationExecutionLease, logger: Logger): Promise<void> {
  try {
    await lease.release();
  } catch (error) {
    logger.error("Could not release a scheduled-run conversation lease", error);
  }
}

function validRetryAt(candidate: Date | undefined, now: Date, deferralMs: number): Date {
  if (candidate !== undefined && Number.isFinite(candidate.getTime()) && candidate > now) {
    return candidate;
  }
  return new Date(now.getTime() + deferralMs);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}
