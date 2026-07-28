import { resolve } from "node:path";
import { z } from "zod";
import type { LogLevel } from "../shared/logger.js";
import type { UpdateMode } from "../update/monitor.js";

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .default("true")
  .transform((value) => value === "true" || value === "1");

const updateEnvSchema = z.object({
  TELEX_UPDATE_MODE: z.enum(["off", "notify", "auto"]).default("notify"),
  TELEX_UPDATE_INTERVAL_HOURS: z.coerce.number().min(1).max(168).default(6),
  TELEX_UPDATE_REPOSITORY: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .default("sadfun/telex"),
  TELEX_INSTALL_DIR: z.string().min(1).optional(),
});

const envSchema = z.object({
  ...updateEnvSchema.shape,
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1).optional(),
  TELEGRAM_API_BASE: z.url().default("https://api.telegram.org"),
  TELEGRAM_POLL_TIMEOUT: z.coerce.number().int().min(1).max(50).default(30),
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-").optional(),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-").optional(),
  SLACK_ALLOWED_USER_IDS: z.string().min(1).optional(),
  SLACK_ADMIN_USER_IDS: z.string().min(1).optional(),
  PUBLIC_URL: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "PUBLIC_URL must use HTTPS")
    .optional(),
  TELEX_TUNNEL: z.enum(["auto", "off"]).default("auto"),
  TELEX_DATA_DIR: z.string().min(1).default(".telex"),
  CODEX_WORKSPACE: z.string().min(1).default(".telex/workspace"),
  CODEX_CHECK_UPDATES: booleanString,
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface SlackConfig {
  readonly botToken: string;
  readonly appToken: string;
  /** Empty when {@link allowAllWorkspaceMembers} is on. */
  readonly allowedUserIds: ReadonlySet<string>;
  /** `SLACK_ALLOWED_USER_IDS=*`: every regular member of the workspace. */
  readonly allowAllWorkspaceMembers: boolean;
  /** When set, instance-wide commands (config, login, restart…) are limited to these users. */
  readonly adminUserIds: ReadonlySet<string> | undefined;
}

export interface TelegramConfig {
  readonly botToken: string;
  readonly allowedUserIds: ReadonlySet<number>;
}

export interface AppConfig {
  readonly telegram: TelegramConfig | undefined;
  readonly telegramApiBase: string;
  readonly telegramPollTimeout: number;
  readonly slack: SlackConfig | undefined;
  readonly publicUrl: string | undefined;
  readonly tunnelMode: "auto" | "off";
  readonly dataDirectory: string;
  readonly workspace: string;
  readonly checkCodexUpdates: boolean;
  readonly updateMode: UpdateMode;
  readonly updateIntervalMs: number;
  readonly updateRepository: string;
  readonly installDirectory: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
}

export interface UpdateConfig {
  readonly updateMode: UpdateMode;
  readonly updateIntervalMs: number;
  readonly updateRepository: string;
  readonly installDirectory: string | undefined;
}

export function loadAppConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(environment);
  const telegram = telegramConfigFromParsed(parsed);
  const slack = slackConfigFromParsed(parsed);
  if (telegram === undefined && slack === undefined) {
    throw new Error(
      "Configure at least one connector: Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_IDS) or Slack (SLACK_BOT_TOKEN + SLACK_APP_TOKEN + SLACK_ALLOWED_USER_IDS)",
    );
  }

  return {
    ...updateConfigFromParsed(parsed),
    telegram,
    telegramApiBase: parsed.TELEGRAM_API_BASE.replace(/\/$/, ""),
    telegramPollTimeout: parsed.TELEGRAM_POLL_TIMEOUT,
    slack,
    publicUrl: parsed.PUBLIC_URL?.replace(/\/$/, ""),
    tunnelMode: parsed.TELEX_TUNNEL,
    dataDirectory: resolve(parsed.TELEX_DATA_DIR),
    workspace: resolve(parsed.CODEX_WORKSPACE),
    checkCodexUpdates: parsed.CODEX_CHECK_UPDATES,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
  };
}

export function loadUpdateConfig(environment: NodeJS.ProcessEnv = process.env): UpdateConfig {
  return updateConfigFromParsed(updateEnvSchema.parse(environment));
}

function telegramConfigFromParsed(parsed: z.infer<typeof envSchema>): TelegramConfig | undefined {
  const fields = [parsed.TELEGRAM_BOT_TOKEN, parsed.TELEGRAM_ALLOWED_USER_IDS];
  if (fields.every((field) => field === undefined)) return undefined;
  if (fields.some((field) => field === undefined)) {
    throw new Error(
      "The Telegram connector needs TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS set together",
    );
  }
  const allowedUserIds = new Set(
    (parsed.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((part) => z.coerce.number().int().positive().safe().parse(part.trim())),
  );
  return { botToken: parsed.TELEGRAM_BOT_TOKEN ?? "", allowedUserIds };
}

function slackConfigFromParsed(parsed: z.infer<typeof envSchema>): SlackConfig | undefined {
  const fields = [parsed.SLACK_BOT_TOKEN, parsed.SLACK_APP_TOKEN, parsed.SLACK_ALLOWED_USER_IDS];
  if (fields.every((field) => field === undefined)) {
    if (parsed.SLACK_ADMIN_USER_IDS !== undefined) {
      throw new Error("SLACK_ADMIN_USER_IDS requires the Slack connector to be configured");
    }
    return undefined;
  }
  if (fields.some((field) => field === undefined)) {
    throw new Error(
      "The Slack connector needs SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_ALLOWED_USER_IDS set together",
    );
  }
  const adminUserIds =
    parsed.SLACK_ADMIN_USER_IDS === undefined
      ? undefined
      : parseSlackUserIds(parsed.SLACK_ADMIN_USER_IDS);
  if ((parsed.SLACK_ALLOWED_USER_IDS ?? "").trim() === "*") {
    return {
      botToken: parsed.SLACK_BOT_TOKEN ?? "",
      appToken: parsed.SLACK_APP_TOKEN ?? "",
      allowedUserIds: new Set(),
      allowAllWorkspaceMembers: true,
      adminUserIds,
    };
  }
  return {
    botToken: parsed.SLACK_BOT_TOKEN ?? "",
    appToken: parsed.SLACK_APP_TOKEN ?? "",
    allowedUserIds: parseSlackUserIds(parsed.SLACK_ALLOWED_USER_IDS ?? ""),
    allowAllWorkspaceMembers: false,
    adminUserIds,
  };
}

function parseSlackUserIds(raw: string): ReadonlySet<string> {
  return new Set(
    raw.split(",").map((part) =>
      z
        .string()
        .regex(
          /^[UW][A-Z0-9]{2,}$/u,
          "Slack user IDs look like U0123ABCDEF, or * for every workspace member",
        )
        .parse(part.trim().toUpperCase()),
    ),
  );
}

function updateConfigFromParsed(parsed: z.infer<typeof updateEnvSchema>): UpdateConfig {
  return {
    updateMode: parsed.TELEX_UPDATE_MODE,
    updateIntervalMs: parsed.TELEX_UPDATE_INTERVAL_HOURS * 60 * 60 * 1_000,
    updateRepository: parsed.TELEX_UPDATE_REPOSITORY,
    installDirectory:
      parsed.TELEX_INSTALL_DIR === undefined ? undefined : resolve(parsed.TELEX_INSTALL_DIR),
  };
}
