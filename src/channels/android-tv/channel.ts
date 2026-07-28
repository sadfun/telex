import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { CodexService } from "../../codex/service.js";
import type {
  ChoiceOption,
  DeliveryReceipt,
  InboundMessage,
  MessageHandler,
  MessageResponder,
  MessagingChannel,
  OutboundMessage,
  OutboundStream,
  ProviderReference,
} from "../../core/channel.js";
import type { Thread } from "../../generated/codex/v2/Thread.js";
import type { Deferred } from "../../shared/async.js";
import { deferred } from "../../shared/async.js";
import { BridgeError, errorMessage } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";
import type { AndroidTvDevice, AndroidTvDeviceStore } from "./device-store.js";
import type { AndroidTvPairingService } from "./pairing.js";

const MAX_REQUEST_BYTES = 32 * 1_024;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const pairingRequestSchema = z.strictObject({
  deviceName: z.string().trim().min(1).max(80),
  appVersion: z.string().trim().min(1).max(40).optional(),
  platformVersion: z.string().trim().min(1).max(80).optional(),
});
const messageRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(32_000),
  threadId: z.string().uuid().optional(),
});
const choiceRequestSchema = z.strictObject({
  optionId: z.string().min(1).max(128),
});

export interface AndroidTvHttpHandler {
  handleHttp(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
}

export interface AndroidTvChannelOptions {
  readonly devices: AndroidTvDeviceStore;
  readonly pairing: AndroidTvPairingService;
  readonly codex: CodexService;
  readonly logger: Logger;
}

interface PendingChoice {
  readonly deviceId: string;
  readonly options: readonly ChoiceOption[];
  readonly result: Deferred<string>;
  readonly timer: NodeJS.Timeout;
}

interface TvEvent {
  readonly id: number;
  readonly type:
    | "progress"
    | "delta"
    | "complete"
    | "error"
    | "message"
    | "choice"
    | "notification";
  readonly requestId?: string;
  readonly payload: unknown;
}

interface EventSubscription {
  readonly response: ServerResponse;
  readonly heartbeat: NodeJS.Timeout;
}

export class AndroidTvChannel implements MessagingChannel, AndroidTvHttpHandler {
  public readonly name = "android-tv";
  readonly #devices: AndroidTvDeviceStore;
  readonly #pairing: AndroidTvPairingService;
  readonly #codex: CodexService;
  readonly #logger: Logger;
  readonly #events = new Map<string, TvEvent[]>();
  readonly #subscriptions = new Map<string, Set<EventSubscription>>();
  readonly #pendingChoices = new Map<string, PendingChoice>();
  readonly #pairingAttempts = new Map<string, number[]>();
  #eventId = 0;
  #handler: MessageHandler | undefined;

  public constructor(options: AndroidTvChannelOptions) {
    this.#devices = options.devices;
    this.#pairing = options.pairing;
    this.#codex = options.codex;
    this.#logger = options.logger;
  }

  public async start(handler: MessageHandler): Promise<void> {
    this.#handler = handler;
    this.#logger.info("Android TV adapter enabled");
  }

  public isAuthorized(principal: ProviderReference): boolean {
    return (
      principal.provider === this.name &&
      (principal.resource === "user" || principal.resource === "destination") &&
      this.#devices.hasDevice(principal.id)
    );
  }

  public async publish(
    target: ProviderReference,
    message: OutboundMessage,
  ): Promise<DeliveryReceipt> {
    if (
      target.provider !== this.name ||
      target.resource !== "destination" ||
      !this.#devices.hasDevice(target.id)
    ) {
      throw new Error("Unknown Android TV delivery target");
    }
    const reference: ProviderReference = {
      provider: this.name,
      resource: "message",
      id: randomUUID(),
    };
    this.emit(target.id, {
      type: "notification",
      payload: {
        id: reference.id,
        text: message.text,
        attachments: message.attachments ?? [],
        actions: message.actions ?? [],
      },
    });
    return { publishedMessages: [reference] };
  }

  public async stop(): Promise<void> {
    this.#handler = undefined;
    for (const subscriptions of this.#subscriptions.values()) {
      for (const subscription of subscriptions) {
        clearInterval(subscription.heartbeat);
        subscription.response.end();
      }
    }
    this.#subscriptions.clear();
    for (const choice of this.#pendingChoices.values()) {
      clearTimeout(choice.timer);
      choice.result.reject(new Error("Android TV adapter stopped"));
    }
    this.#pendingChoices.clear();
  }

  public async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (!url.pathname.startsWith("/api/tv/")) return false;
    try {
      await this.routeHttp(request, response, url);
    } catch (error) {
      this.#logger.warn("Android TV API request failed", {
        method: request.method,
        path: url.pathname,
        error: errorMessage(error),
      });
      this.handleHttpError(response, error);
    }
    return true;
  }

  private async routeHttp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method === "POST" && url.pathname === "/api/tv/pairings") {
      this.enforcePairingRateLimit(request.socket.remoteAddress ?? "unknown");
      const input = pairingRequestSchema.parse(await this.readJson(request));
      const challenge = this.#pairing.create(input.deviceName);
      this.sendJson(response, 201, {
        pairingId: challenge.id,
        code: challenge.code,
        expiresAt: challenge.expiresAt,
        pollAfterMs: 1_500,
        instructions: `Send /pair ${challenge.code} to your Telex bot.`,
      });
      return;
    }

    const pairingId = routeParameter(url.pathname, "/api/tv/pairings/");
    if (request.method === "GET" && pairingId !== undefined) {
      const status = this.#pairing.status(pairingId);
      this.sendJson(response, status.status === "not_found" ? 404 : 200, status);
      return;
    }

    const device = this.authenticate(request);
    void this.#devices.touch(device.id).catch((error: unknown) => {
      this.#logger.warn("Could not update Android TV last-seen time", {
        deviceId: device.id,
        error: errorMessage(error),
      });
    });

    if (request.method === "GET" && url.pathname === "/api/tv/device") {
      this.sendJson(response, 200, {
        device: { id: device.id, name: device.name, owner: device.owner },
      });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/api/tv/device") {
      await this.#devices.remove(device.id);
      this.disconnectDevice(device.id);
      this.sendJson(response, 200, { revoked: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tv/events") {
      this.subscribe(device.id, request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tv/sessions") {
      const threads = await this.#codex.listConversationThreads(conversationPrefixes(device));
      this.sendJson(response, 200, { sessions: threads.map(toSessionSummary) });
      return;
    }

    const activateThreadId = routeParameter(url.pathname, "/api/tv/sessions/", "/activate");
    if (request.method === "POST" && activateThreadId !== undefined) {
      await this.#codex.readConversationThread(conversationPrefixes(device), activateThreadId);
      await this.#codex.activateConversationThread(conversationKey(device), activateThreadId);
      this.sendJson(response, 200, { activeThreadId: activateThreadId });
      return;
    }

    const threadId = routeParameter(url.pathname, "/api/tv/sessions/");
    if (request.method === "GET" && threadId !== undefined) {
      const thread = await this.#codex.readConversationThread(
        conversationPrefixes(device),
        threadId,
      );
      this.sendJson(response, 200, toSessionDetail(thread));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tv/messages") {
      const input = messageRequestSchema.parse(await this.readJson(request));
      if (input.threadId !== undefined) {
        await this.#codex.readConversationThread(conversationPrefixes(device), input.threadId);
        await this.#codex.activateConversationThread(conversationKey(device), input.threadId);
      }
      const handler = this.#handler;
      if (handler === undefined) throw new TvHttpError(503, "Android TV adapter is starting");
      const requestId = randomUUID();
      const responder = new AndroidTvResponder(
        requestId,
        (event) => this.emit(device.id, event),
        async (prompt, options) => await this.requestChoice(device.id, requestId, prompt, options),
      );
      this.sendJson(response, 202, { requestId });
      const inbound: InboundMessage = {
        id: requestId,
        address: {
          channel: this.name,
          key: conversationKey(device),
          isPrivate: true,
          isGuest: false,
          deliveryTarget: {
            provider: this.name,
            resource: "destination",
            id: device.id,
          },
        },
        sender: { id: device.id, displayName: device.name },
        text: input.text,
        attachments: [],
        responder,
      };
      void handler(inbound).catch(async (error: unknown) => {
        this.#logger.error("Android TV message handler failed", error, { requestId });
        await responder.sendText(`Bridge error: ${errorMessage(error)}`);
      });
      return;
    }

    const choiceId = routeParameter(url.pathname, "/api/tv/choices/");
    if (request.method === "POST" && choiceId !== undefined) {
      const input = choiceRequestSchema.parse(await this.readJson(request));
      this.resolveChoice(device.id, choiceId, input.optionId);
      this.sendJson(response, 200, { accepted: true });
      return;
    }

    throw new TvHttpError(404, "Not found");
  }

  private authenticate(request: IncomingMessage): AndroidTvDevice {
    const authorization = request.headers.authorization;
    const match = /^Bearer ([A-Za-z0-9_-]{20,})$/u.exec(authorization ?? "");
    const device = match?.[1] === undefined ? undefined : this.#devices.authenticate(match[1]);
    if (device === undefined) throw new TvHttpError(401, "A valid device token is required");
    this.#pairing.consumeForDevice(device.id);
    return device;
  }

  private emit(deviceId: string, event: Omit<TvEvent, "id">): void {
    const stored: TvEvent = { id: ++this.#eventId, ...event };
    const history = this.#events.get(deviceId) ?? [];
    history.push(stored);
    if (history.length > 100) history.splice(0, history.length - 100);
    this.#events.set(deviceId, history);
    for (const subscription of this.#subscriptions.get(deviceId) ?? []) {
      writeSse(subscription.response, stored);
    }
  }

  private subscribe(deviceId: string, request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.write(": connected\n\n");
    const lastEventId = Number(request.headers["last-event-id"] ?? "0");
    if (Number.isSafeInteger(lastEventId)) {
      for (const event of this.#events.get(deviceId) ?? []) {
        if (event.id > lastEventId) writeSse(response, event);
      }
    }
    const subscription: EventSubscription = {
      response,
      heartbeat: setInterval(() => response.write(": keepalive\n\n"), 20_000),
    };
    const subscriptions = this.#subscriptions.get(deviceId) ?? new Set<EventSubscription>();
    subscriptions.add(subscription);
    this.#subscriptions.set(deviceId, subscriptions);
    response.once("close", () => {
      clearInterval(subscription.heartbeat);
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) this.#subscriptions.delete(deviceId);
    });
  }

  private async requestChoice(
    deviceId: string,
    requestId: string,
    prompt: string,
    options: readonly ChoiceOption[],
  ): Promise<string> {
    const choiceId = randomUUID();
    const result = deferred<string>();
    const timer = setTimeout(
      () => {
        this.#pendingChoices.delete(choiceId);
        result.reject(new Error("Android TV choice timed out"));
      },
      15 * 60 * 1_000,
    );
    this.#pendingChoices.set(choiceId, { deviceId, options, result, timer });
    this.emit(deviceId, {
      type: "choice",
      requestId,
      payload: { choiceId, prompt, options },
    });
    return await result.promise;
  }

  private resolveChoice(deviceId: string, choiceId: string, optionId: string): void {
    const pending = this.#pendingChoices.get(choiceId);
    if (pending === undefined || pending.deviceId !== deviceId) {
      throw new TvHttpError(404, "Choice request not found");
    }
    if (!pending.options.some((option) => option.id === optionId)) {
      throw new TvHttpError(400, "Unknown choice option");
    }
    clearTimeout(pending.timer);
    this.#pendingChoices.delete(choiceId);
    pending.result.resolve(optionId);
  }

  private disconnectDevice(deviceId: string): void {
    for (const subscription of this.#subscriptions.get(deviceId) ?? []) {
      clearInterval(subscription.heartbeat);
      subscription.response.end();
    }
    this.#subscriptions.delete(deviceId);
    this.#events.delete(deviceId);
    for (const [choiceId, choice] of this.#pendingChoices) {
      if (choice.deviceId !== deviceId) continue;
      clearTimeout(choice.timer);
      this.#pendingChoices.delete(choiceId);
      choice.result.reject(new Error("Android TV device disconnected"));
    }
  }

  private enforcePairingRateLimit(address: string): void {
    const cutoff = Date.now() - 60_000;
    const attempts = (this.#pairingAttempts.get(address) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (attempts.length >= 5) throw new TvHttpError(429, "Too many pairing attempts");
    attempts.push(Date.now());
    this.#pairingAttempts.set(address, attempts);
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new TvHttpError(415, "Content-Type must be application/json");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new TvHttpError(413, "Request body is too large");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new TvHttpError(400, "Invalid JSON body");
    }
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      "Content-Length": String(body.byteLength),
      "Content-Type": JSON_CONTENT_TYPE,
    });
    response.end(body);
  }

  private handleHttpError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof TvHttpError) {
      if (error.status === 401) response.setHeader("WWW-Authenticate", "Bearer");
      this.sendJson(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      this.sendJson(response, 400, { error: "Invalid request", issues: error.issues });
      return;
    }
    if (error instanceof BridgeError) {
      const status =
        error.code === "THREAD_FORBIDDEN" ? 403 : error.code === "CONVERSATION_BUSY" ? 409 : 502;
      this.sendJson(response, status, { error: error.message });
      return;
    }
    this.sendJson(response, 500, { error: "Internal server error" });
  }
}

class AndroidTvResponder implements MessageResponder {
  readonly #requestId: string;
  readonly #emit: (event: Omit<TvEvent, "id">) => void;
  readonly #requestChoice: (prompt: string, options: readonly ChoiceOption[]) => Promise<string>;

  public constructor(
    requestId: string,
    emit: (event: Omit<TvEvent, "id">) => void,
    requestChoice: (prompt: string, options: readonly ChoiceOption[]) => Promise<string>,
  ) {
    this.#requestId = requestId;
    this.#emit = emit;
    this.#requestChoice = requestChoice;
  }

  public createStream(): OutboundStream {
    return {
      start: async (progress) => {
        if (progress !== undefined) this.sendEvent("progress", progress);
      },
      setProgress: (progress) => this.sendEvent("progress", progress),
      appendFinal: (delta) => this.sendEvent("delta", { delta }),
      complete: async (text, attachments) => {
        this.sendEvent("complete", { text, attachments: attachments ?? [] });
      },
      fail: async (message) => this.sendEvent("error", { message }),
    };
  }

  public async sendText(text: string): Promise<void> {
    this.sendEvent("message", { text });
  }

  public async askChoice(prompt: string, options: readonly ChoiceOption[]): Promise<string> {
    return await this.#requestChoice(prompt, options);
  }

  private sendEvent(type: TvEvent["type"], payload: unknown): void {
    this.#emit({ type, requestId: this.#requestId, payload });
  }
}

function conversationKey(device: AndroidTvDevice): string {
  return `android-tv:${device.owner.provider}:${device.owner.id}`;
}

function conversationPrefixes(device: AndroidTvDevice): readonly string[] {
  return [`${device.owner.provider}:${device.owner.id}`, conversationKey(device)];
}

function toSessionSummary(thread: Thread): unknown {
  return {
    id: thread.id,
    title: thread.name ?? firstLine(thread.preview) ?? "Untitled task",
    preview: thread.preview,
    createdAt: new Date(thread.createdAt * 1_000).toISOString(),
    updatedAt: new Date(thread.updatedAt * 1_000).toISOString(),
    status: thread.status.type,
  };
}

function toSessionDetail(thread: Thread): unknown {
  const messages = thread.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      if (item.type === "userMessage") {
        const text = item.content
          .flatMap((content) => (content.type === "text" ? [content.text] : []))
          .join("\n");
        return text.length === 0
          ? []
          : [
              {
                id: item.id,
                role: "user",
                text,
                timestamp:
                  turn.startedAt === null ? null : new Date(turn.startedAt * 1_000).toISOString(),
              },
            ];
      }
      if (item.type === "agentMessage" && item.text.length > 0) {
        return [
          {
            id: item.id,
            role: "assistant",
            text: item.text,
            timestamp:
              turn.completedAt === null ? null : new Date(turn.completedAt * 1_000).toISOString(),
          },
        ];
      }
      return [];
    }),
  );
  return { session: toSessionSummary(thread), messages };
}

function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/u, 1)[0]?.trim();
  return line === undefined || line.length === 0 ? undefined : line.slice(0, 120);
}

function routeParameter(path: string, prefix: string, suffix = ""): string | undefined {
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return undefined;
  const value = path.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length);
  if (value.length === 0 || value.includes("/")) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function writeSse(response: ServerResponse, event: TvEvent): void {
  response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

class TvHttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "TvHttpError";
  }
}
