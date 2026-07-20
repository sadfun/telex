import { z } from "zod";
import type { ProviderReference } from "../core/channel.js";

export type { ProviderReference } from "../core/channel.js";

const identifierSchema = z.string().trim().min(1).max(256);

export const instantSchema = z
  .string()
  .refine(
    (value) => isStrictIsoInstant(value),
    "Expected an ISO 8601 instant with an explicit UTC offset",
  );

export function isStrictIsoInstant(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[7] === "Z" ? 0 : Number(match[10]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    offsetHour >= 0 &&
    offsetHour <= 23 &&
    offsetMinute >= 0 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * An opaque provider-owned address. Telex core never parses `id`; an adapter may
 * use formats such as `chat:123:topic:7` or `channel:C123:thread:456`.
 */
export const providerReferenceSchema: z.ZodType<ProviderReference> = z.strictObject({
  provider: identifierSchema,
  resource: z.enum(["conversation", "destination", "message", "user"]),
  id: z.string().min(1).max(2_048),
});

export const automationScheduleSchema = z.strictObject({
  rrule: z.string().trim().min(1).max(4_096),
  startAt: instantSchema,
  timeZone: z.string().trim().min(1).max(128),
});

export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

const newThreadExecutionSchema = z.strictObject({
  mode: z.literal("new-thread"),
  cwd: z.string().min(1),
});

const existingThreadExecutionSchema = z.strictObject({
  mode: z.literal("existing-thread"),
  threadId: identifierSchema,
});

export const automationExecutionSchema = z.discriminatedUnion("mode", [
  newThreadExecutionSchema,
  existingThreadExecutionSchema,
]);

export type AutomationExecution = z.infer<typeof automationExecutionSchema>;

export const automationDefinitionSchema = z.strictObject({
  id: identifierSchema,
  owner: providerReferenceSchema,
  conversation: providerReferenceSchema,
  deliveryTarget: providerReferenceSchema,
  kind: z.enum(["cron", "heartbeat"]),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  status: z.enum(["active", "paused", "deleted"]),
  schedule: automationScheduleSchema,
  execution: automationExecutionSchema,
  notificationPolicy: z.enum(["always", "on-result", "never"]),
  model: z.string().min(1).nullable(),
  reasoningEffort: z.string().min(1).nullable(),
  nextRunAt: instantSchema.nullable(),
  lastRunAt: instantSchema.nullable(),
  deferredUntil: instantSchema.nullable(),
  deferralReason: z.string().max(1_000).nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  revision: z.number().int().nonnegative(),
});

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

export const automationRunStatusSchema = z.enum(["running", "succeeded", "failed", "interrupted"]);

export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;

export const automationRunSchema = z.strictObject({
  id: identifierSchema,
  automationId: identifierSchema,
  scheduledFor: instantSchema,
  status: automationRunStatusSchema,
  startedAt: instantSchema,
  finishedAt: instantSchema.nullable(),
  threadId: identifierSchema.nullable(),
  summary: z.string().max(4_000).nullable(),
  error: z.string().max(20_000).nullable(),
});

export type AutomationRun = z.infer<typeof automationRunSchema>;

export const automationNotificationStatusSchema = z.enum([
  "pending",
  "delivered",
  "failed",
  "suppressed",
]);

export type AutomationNotificationStatus = z.infer<typeof automationNotificationStatusSchema>;

export const automationNotificationSchema = z.strictObject({
  id: identifierSchema,
  automationId: identifierSchema,
  runId: identifierSchema,
  target: providerReferenceSchema,
  publishedMessages: z.array(providerReferenceSchema).max(100).readonly(),
  sourceThreadId: identifierSchema.nullable(),
  status: automationNotificationStatusSchema,
  title: z.string().max(500).nullable(),
  body: z.string().max(20_000).nullable(),
  error: z.string().max(20_000).nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export type AutomationNotification = z.infer<typeof automationNotificationSchema>;

export interface AutomationRunCompletion {
  readonly status: Exclude<AutomationRunStatus, "running">;
  readonly finishedAt: string;
  readonly threadId?: string;
  readonly summary?: string;
  readonly error?: string;
}
