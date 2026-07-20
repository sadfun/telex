import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type CodexConfigService, ConfigValidationError } from "../src/codex/config-service.js";
import type { TelexSettings, TelexSettingsStore } from "../src/core/settings-store.js";
import type { ConfigWriteResponse } from "../src/generated/codex/v2/ConfigWriteResponse.js";
import { MiniAppServer } from "../src/miniapp/server.js";
import type { Logger } from "../src/shared/logger.js";

const botToken = "123456:abcdefghijklmnopqrstuvwxyzABCDE";

describe("MiniAppServer config API", () => {
  it("returns the fresh snapshot with the generated write outcome", async () => {
    const snapshot = {
      version: "revision-2",
      values: { model: "gpt-test" },
      capabilities: { models: [] },
      validation: { valid: true, issues: [] },
    };
    const writeOutcome: ConfigWriteResponse = {
      status: "okOverridden",
      version: "revision-2",
      filePath: "/tmp/codex/config.toml",
      overriddenMetadata: {
        message: "A project layer overrides this value.",
        overridingLayer: {
          name: { type: "project", dotCodexFolder: "/workspace/.codex" },
          version: "project-revision",
        },
        effectiveValue: "gpt-managed",
      },
    };
    const update = vi.fn(async (_input: unknown) => writeOutcome);
    const read = vi.fn(async () => snapshot);
    const server = testServer({
      update,
      read,
      validate: vi.fn(async () => ({ valid: true, issues: [] })),
    });

    const response = await dispatch(
      server,
      request("PUT", "/api/config", {
        expectedVersion: "revision-1",
        values: { model: "gpt-test" },
      }),
    );

    expect(response.status).toBe(200);
    expect(responseJson(response)).toEqual({
      ...snapshot,
      writeOutcome,
      telex: { remoteClientContext: true },
    });
    expect(update).toHaveBeenCalledWith({
      expectedVersion: "revision-1",
      values: { model: "gpt-test" },
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it("updates Telex settings without rewriting Codex config", async () => {
    const snapshot = {
      version: "revision-1",
      values: { model: "gpt-test" },
      capabilities: { models: [] },
      validation: { valid: true, issues: [] },
    };
    const update = vi.fn();
    const settings = testSettingsStore();
    const server = testServer(
      {
        update,
        read: vi.fn(async () => snapshot),
        validate: vi.fn(),
      },
      settings,
    );

    const response = await dispatch(
      server,
      request("PUT", "/api/config", {
        expectedVersion: "revision-1",
        values: {},
        telex: { remoteClientContext: false },
      }),
    );

    expect(response.status).toBe(200);
    expect(responseJson(response)).toEqual({
      ...snapshot,
      telex: { remoteClientContext: false },
    });
    expect(update).not.toHaveBeenCalled();
    expect(settings.update).toHaveBeenCalledWith({ remoteClientContext: false });
  });

  it("normalizes Zod request failures for inline field display", async () => {
    const requestSchema = z.strictObject({
      expectedVersion: z.string(),
      values: z.strictObject({ model: z.string().max(3) }),
    });
    const server = testServer({
      update: vi.fn(),
      read: vi.fn(),
      validate: async (input: unknown) => requestSchema.parse(input),
    });

    const response = await dispatch(
      server,
      request("POST", "/api/config/validate", {
        expectedVersion: "revision-1",
        values: { model: "too-long" },
      }),
    );
    const body = responseJson(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: "Invalid config update" });
    expect((body as { issues: unknown }).issues).toEqual([
      {
        path: "values.model",
        severity: "error",
        message: expect.any(String),
      },
    ]);
  });

  it("keeps semantic validation failures in the same structured issue shape", async () => {
    const issues = [
      {
        path: "model_reasoning_effort",
        severity: "error" as const,
        message: "The selected model does not support this effort.",
      },
    ];
    const server = testServer({
      update: vi.fn(),
      read: vi.fn(),
      validate: async () => {
        throw new ConfigValidationError(issues);
      },
    });

    const response = await dispatch(
      server,
      request("POST", "/api/config/validate", {
        expectedVersion: "revision-1",
        values: { model: "gpt-test" },
      }),
    );

    expect(response.status).toBe(422);
    expect(responseJson(response)).toEqual({
      error: "The config update is invalid",
      issues,
    });
  });
});

interface TestConfigService {
  readonly read: () => Promise<unknown>;
  readonly update: (input: unknown) => Promise<unknown>;
  readonly validate: (input: unknown) => Promise<unknown>;
}

interface TestableMiniAppServer {
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  readonly handleError: (response: ServerResponse, error: unknown) => void;
}

interface CapturedResponse {
  readonly response: ServerResponse;
  status: number | undefined;
  body: Buffer | undefined;
}

function testServer(
  configService: TestConfigService,
  settings: TestSettingsStore = testSettingsStore(),
): MiniAppServer {
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
  } as unknown as Logger;
  return new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    botToken,
    allowedUserIds: new Set([42]),
    configService: configService as unknown as CodexConfigService,
    settings: settings as unknown as TelexSettingsStore,
    logger,
  });
}

interface TestSettingsStore {
  readonly read: () => TelexSettings;
  readonly update: ReturnType<typeof vi.fn<(input: unknown) => Promise<TelexSettings>>>;
}

function testSettingsStore(): TestSettingsStore {
  let settings: TelexSettings = { remoteClientContext: true };
  return {
    read: () => settings,
    update: vi.fn(async (input: unknown) => {
      settings = input as TelexSettings;
      return settings;
    }),
  };
}

async function dispatch(
  server: MiniAppServer,
  request: IncomingMessage,
): Promise<CapturedResponse> {
  const captured = captureResponse();
  const testable = server as unknown as TestableMiniAppServer;
  try {
    await testable.handle(request, captured.response);
  } catch (error) {
    testable.handleError(captured.response, error);
  }
  return captured;
}

function request(method: string, url: string, body: unknown): IncomingMessage {
  const encoded = Buffer.from(JSON.stringify(body));
  return {
    method,
    url,
    headers: {
      authorization: `tma ${signedInitData()}`,
      "content-type": "application/json",
    },
    [Symbol.asyncIterator]: async function* () {
      yield encoded;
    },
  } as unknown as IncomingMessage;
}

function captureResponse(): CapturedResponse {
  const captured = {
    status: undefined,
    body: undefined,
  } as CapturedResponse;
  const response = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead(status: number) {
      captured.status = status;
      response.headersSent = true;
      return response;
    },
    end(body?: Uint8Array) {
      captured.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
      return response;
    },
    destroy: vi.fn(),
  };
  Object.assign(captured, { response: response as unknown as ServerResponse });
  return captured;
}

function responseJson(response: CapturedResponse): Readonly<Record<string, unknown>> {
  if (response.body === undefined) throw new Error("Mini App response body is missing");
  return JSON.parse(response.body.toString("utf8")) as Readonly<Record<string, unknown>>;
}

function signedInitData(): string {
  const fields = new Map<string, string>([
    ["auth_date", String(Math.floor(Date.now() / 1_000))],
    ["query_id", "AAEAAAE"],
    ["user", JSON.stringify({ id: 42, first_name: "Ada" })],
  ]);
  const dataCheckString = [...fields.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams([...fields, ["hash", hash]]).toString();
}
