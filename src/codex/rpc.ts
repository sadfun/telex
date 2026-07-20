import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ClientNotification } from "../generated/codex/ClientNotification.js";
import type { ClientRequest } from "../generated/codex/ClientRequest.js";
import type { InitializeResponse } from "../generated/codex/InitializeResponse.js";
import type { RequestId } from "../generated/codex/RequestId.js";
import type { ServerNotification } from "../generated/codex/ServerNotification.js";
import type { ServerRequest } from "../generated/codex/ServerRequest.js";
import type { TurnStartParams } from "../generated/codex/v2/TurnStartParams.js";
import { type Deferred, deferred, delay, withTimeout } from "../shared/async.js";
import { externalProcessEnvironment } from "../shared/environment.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";

type StableClientRequestInput = ClientRequest extends infer Request
  ? Request extends { id: RequestId }
    ? Omit<Request, "id">
    : never
  : never;

export interface ApplicationContextEntry {
  readonly value: string;
  readonly kind: "application";
}

export type ApplicationContext = Readonly<Record<string, ApplicationContextEntry>>;

interface TurnStartWithAdditionalContext {
  readonly method: "turn/start";
  readonly params: TurnStartParams & {
    readonly additionalContext: ApplicationContext;
  };
}

type ClientRequestInput = StableClientRequestInput | TurnStartWithAdditionalContext;

const wireMessageSchema = z
  .object({
    id: z.union([z.string(), z.number().int()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .loose();

interface PendingRequest {
  readonly deferred: Deferred<unknown>;
}

export class CodexRpcError extends BridgeError {
  public readonly rpcCode: number;
  public readonly data: unknown;

  public constructor(message: string, rpcCode: number, data?: unknown) {
    super(message, "CODEX_RPC_ERROR");
    this.rpcCode = rpcCode;
    this.data = data;
    this.name = "CodexRpcError";
  }
}

export type NotificationListener = (notification: ServerNotification) => void;
export type ServerRequestHandler = (request: ServerRequest) => Promise<void>;

export class CodexAppServer {
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #notificationListeners = new Set<NotificationListener>();
  #serverRequestHandler: ServerRequestHandler | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #stopping = false;
  readonly #binaryPath: string;
  readonly #workspace: string;
  readonly #codexHome: string;
  readonly #clientVersion: string;
  readonly #logger: Logger;

  public constructor(
    binaryPath: string,
    workspace: string,
    codexHome: string,
    clientVersion: string,
    logger: Logger,
  ) {
    this.#binaryPath = binaryPath;
    this.#workspace = workspace;
    this.#codexHome = codexHome;
    this.#clientVersion = clientVersion;
    this.#logger = logger;
  }

  public async start(): Promise<InitializeResponse> {
    if (this.#child !== undefined) {
      throw new BridgeError("Codex app-server is already started", "CODEX_ALREADY_STARTED");
    }

    const child = spawn(
      this.#binaryPath,
      ["app-server", "--strict-config", "--listen", "stdio://"],
      {
        cwd: this.#workspace,
        env: externalProcessEnvironment({
          CODEX_HOME: this.#codexHome,
          LOG_FORMAT: "json",
        }),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    this.#child = child;
    child.once("exit", (code, signal) => this.handleExit(code, signal));
    child.once("error", (error) => this.handleExit(null, errorMessage(error)));

    const stdout = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
    stderr.on("line", (line) => this.#logger.debug("Codex app-server", { line }));

    await once(child, "spawn");
    const initialized = await this.request<InitializeResponse>({
      method: "initialize",
      params: {
        clientInfo: {
          name: "telex",
          title: "Telex",
          version: this.#clientVersion,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
    const notification: ClientNotification = { method: "initialized" };
    await this.write(notification);
    this.#logger.info("Codex app-server initialized", {
      userAgent: initialized.userAgent,
      platform: initialized.platformOs,
    });
    return initialized;
  }

  public onNotification(listener: NotificationListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  public setServerRequestHandler(handler: ServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  public async request<Result>(request: ClientRequestInput): Promise<Result> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await this.requestOnce(request)) as Result;
      } catch (error) {
        if (!(error instanceof CodexRpcError) || error.rpcCode !== -32_001 || attempt >= 3) {
          throw error;
        }
        await delay(100 * 2 ** attempt + Math.floor(Math.random() * 100));
      }
    }
  }

  public async reply(id: RequestId, result: unknown): Promise<void> {
    await this.write({ id, result });
  }

  public async replyError(id: RequestId, code: number, message: string): Promise<void> {
    await this.write({ id, error: { code, message } });
  }

  public async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#stopping = true;
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit").then(() => undefined),
      delay(5_000).then(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }),
    ]);
    this.#child = undefined;
  }

  private async requestOnce(request: ClientRequestInput): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const pending = deferred<unknown>();
    this.#pending.set(id, { deferred: pending });
    try {
      await this.write({ ...request, id });
      return await withTimeout(pending.promise, 60_000, `Codex RPC ${request.method} timed out`);
    } finally {
      this.#pending.delete(id);
    }
  }

  private async write(message: ClientRequest | ClientNotification | object): Promise<void> {
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed) {
      throw new BridgeError("Codex app-server is not running", "CODEX_NOT_RUNNING");
    }
    if (!child.stdin.write(`${JSON.stringify(message)}\n`, "utf8")) {
      await once(child.stdin, "drain");
    }
  }

  private handleLine(line: string): void {
    let message: z.infer<typeof wireMessageSchema>;
    try {
      message = wireMessageSchema.parse(JSON.parse(line));
    } catch (error) {
      this.#logger.warn("Ignoring invalid Codex app-server message", {
        error: errorMessage(error),
      });
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      if (message.error !== undefined) {
        pending.deferred.reject(
          new CodexRpcError(message.error.message, message.error.code, message.error.data),
        );
      } else {
        pending.deferred.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      const request = message as ServerRequest;
      const handler = this.#serverRequestHandler;
      if (handler === undefined) {
        void this.replyError(message.id, -32_601, "No client handler registered");
      } else {
        void handler(request).catch((error: unknown) => {
          this.#logger.error("Failed to handle Codex server request", error, {
            method: message.method,
          });
          void this.replyError(message.id as RequestId, -32_603, errorMessage(error));
        });
      }
      return;
    }

    if (message.method !== undefined) {
      const notification = message as ServerNotification;
      for (const listener of this.#notificationListeners) listener(notification);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | string | null): void {
    const error = new BridgeError(
      `Codex app-server exited (${code ?? signal ?? "unknown"})`,
      "CODEX_EXITED",
    );
    for (const pending of this.#pending.values()) pending.deferred.reject(error);
    this.#pending.clear();
    this.#child = undefined;
    if (!this.#stopping) this.#logger.error("Codex app-server stopped unexpectedly", error);
  }
}
