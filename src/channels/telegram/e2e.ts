import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Bot, InputFile } from "grammy";
import type { Message } from "grammy/types";
import type { ProviderReference } from "../../core/channel.js";
import {
  type CodexE2eTokenProvider,
  type E2eTelexInstance,
  launchE2eTelex,
} from "../../core/e2e/instance.js";
import {
  type AdjustableE2eClock,
  type E2eScenarioResult,
  runE2eScenario,
  runE2eScenarios,
  validateE2eParallelism,
} from "../../core/e2e/suite.js";
import { E2eTrace } from "../../core/e2e/trace.js";
import type { LogLevel } from "../../shared/logger.js";
import { TelegramChannel } from "./channel.js";
import { normalizeTelegramMessage } from "./message.js";

interface TelegramApiCall {
  readonly method: string;
  readonly body: string;
}

interface TelegramApiUpdate {
  readonly kind: "message" | "guest_message";
  readonly fromId?: number;
}

/** Transparent recorder: every request still executes against the real Telegram Bot API. */
export class TelegramApiProbe {
  readonly #trace: E2eTrace;
  readonly #calls: TelegramApiCall[] = [];
  readonly #completed = new Map<string, number>();
  readonly #updates: TelegramApiUpdate[] = [];
  readonly #server = createServer((request, response) => {
    void this.forward(request, response);
  });
  #baseUrl: string | undefined;

  public constructor(trace: E2eTrace) {
    this.#trace = trace;
  }

  public get baseUrl(): string {
    if (this.#baseUrl === undefined) throw new Error("Telegram API probe is not started");
    return this.#baseUrl;
  }

  public async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("Probe has no TCP port");
    this.#baseUrl = `http://127.0.0.1:${address.port}`;
  }

  public saw(methods: readonly string[], bodyPattern?: RegExp): boolean {
    return this.#calls.some(
      (call) => methods.includes(call.method) && (bodyPattern?.test(call.body) ?? true),
    );
  }

  public count(method: string): number {
    return this.#calls.filter((call) => call.method === method).length;
  }

  public completedCount(method: string): number {
    return this.#completed.get(method) ?? 0;
  }

  public sawUpdateFrom(userId: number): boolean {
    return this.#updates.some((update) => update.fromId === userId);
  }

  public async stop(): Promise<void> {
    if (!this.#server.listening) return;
    this.#server.close();
    await once(this.#server, "close");
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? "/";
    const method = /^\/bot[^/]+\/([^/?]+)/u.exec(path)?.[1] ?? "file";
    const finishTrace =
      method === "getUpdates" ? () => undefined : this.#trace.start(`Telegram API ${method}`);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const contentType = String(request.headers["content-type"] ?? "");
      const inspectable = /json|urlencoded|multipart/u.test(contentType)
        ? body.subarray(0, 128 * 1_024).toString("utf8")
        : "";
      this.#calls.push({ method, body: inspectable });
      const headers = new Headers();
      const hopByHopHeaders = new Set([
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
      ]);
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || hopByHopHeaders.has(name)) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const upstream = await fetch(`https://api.telegram.org${path}`, {
        method: request.method ?? "GET",
        headers,
        ...(body.length === 0 ? {} : { body }),
      });
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        if (!["content-encoding", "content-length", "transfer-encoding"].includes(name)) {
          response.setHeader(name, value);
        }
      });
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      this.#completed.set(method, this.completedCount(method) + 1);
      if (method === "getUpdates") this.recordUpdates(upstreamBody);
      response.end(upstreamBody);
    } catch (error) {
      response.statusCode = 502;
      response.end(
        (error instanceof Error ? error.message : String(error)).replaceAll(
          /bot[0-9]{6,12}:[A-Za-z0-9_-]{30,}/gu,
          "bot<redacted>",
        ),
      );
    } finally {
      finishTrace();
    }
  }

  private recordUpdates(body: Buffer): void {
    try {
      const result = JSON.parse(body.toString("utf8")) as {
        ok?: boolean;
        result?: Array<{
          message?: Message;
          guest_message?: Message;
        }>;
      };
      if (result.ok !== true || !Array.isArray(result.result)) return;
      for (const update of result.result) {
        const message = update.message ?? update.guest_message;
        if (message === undefined) continue;
        this.#updates.push({
          kind: update.message === undefined ? "guest_message" : "message",
          ...(message.from?.id === undefined ? {} : { fromId: message.from.id }),
        });
      }
    } catch {
      // The response remains transparent even if a future Bot API shape is not inspectable.
    }
  }
}

export interface LaunchTelegramE2eOptions {
  readonly telexBotToken: string;
  readonly peerBotToken: string;
  readonly requestToken: CodexE2eTokenProvider;
  readonly clock: AdjustableE2eClock;
  readonly projectRoot?: string;
  readonly codexBinaryPath?: string;
  readonly logLevel?: LogLevel;
  /** Destination used by the peer; direct bot-to-bot mode defaults to the Telex bot username. */
  readonly chatId?: number;
  /** Real forum/topic IDs provide independent Telegram conversation lanes. */
  readonly threadIds?: readonly [number, number, ...number[]];
}

export class TelegramE2eInstance {
  public readonly telex: E2eTelexInstance;
  public readonly driver: TelegramE2eDriver;
  public readonly probe: TelegramApiProbe;
  public readonly threadIds: readonly [number, number, ...number[]] | undefined;

  public constructor(options: {
    telex: E2eTelexInstance;
    driver: TelegramE2eDriver;
    probe: TelegramApiProbe;
    threadIds?: readonly [number, number, ...number[]];
  }) {
    this.telex = options.telex;
    this.driver = options.driver;
    this.probe = options.probe;
    this.threadIds = options.threadIds;
  }

  public async stop(): Promise<void> {
    try {
      await this.telex.stop();
    } finally {
      await this.probe.stop();
    }
  }
}

export async function launchTelegramE2e(
  options: LaunchTelegramE2eOptions,
): Promise<TelegramE2eInstance> {
  const trace = new E2eTrace();
  const probe = new TelegramApiProbe(trace);
  await trace.startupSpan("Start Telegram API probe", async () => await probe.start());
  try {
    const telexBot = new Bot(options.telexBotToken);
    const peerBot = new Bot(options.peerBotToken);
    await trace.startupSpan("Connect both Telegram bots", async () => {
      await Promise.all([telexBot.init(), peerBot.init()]);
    });
    if (telexBot.botInfo.id === peerBot.botInfo.id)
      throw new Error("E2E requires two different bots");
    const driver = new TelegramE2eDriver(
      peerBot,
      telexBot.botInfo.id,
      options.chatId ?? `@${telexBot.botInfo.username}`,
      options.chatId ?? peerBot.botInfo.id,
      trace,
    );
    await trace.startupSpan("Drain peer Telegram updates", async () => await driver.drain());
    const launchOptions = {
      requestToken: options.requestToken,
      trace,
      ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
      ...(options.codexBinaryPath === undefined
        ? {}
        : { codexBinaryPath: options.codexBinaryPath }),
      ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
      now: options.clock.now,
      createChannels: ({
        workspace,
        logger,
      }: Parameters<NonNullable<Parameters<typeof launchE2eTelex>[0]["createChannels"]>>[0]) =>
        new TelegramChannel(
          options.telexBotToken,
          probe.baseUrl,
          new Set([peerBot.botInfo.id]),
          2,
          `${workspace}/.telex/attachments`,
          logger.child({ component: "telegram" }),
          undefined,
          { allowedBotUserIds: new Set([peerBot.botInfo.id]) },
        ),
    };
    const telex = await launchE2eTelex(launchOptions);
    return new TelegramE2eInstance({
      telex,
      driver,
      probe,
      ...(options.threadIds === undefined ? {} : { threadIds: options.threadIds }),
    });
  } catch (error) {
    await probe.stop();
    throw error;
  }
}

export class TelegramE2eDriver {
  readonly #peer: Bot;
  readonly #telexBotId: number;
  readonly #sendChatId: number | string;
  readonly #conversationChatId: number;
  readonly #trace: E2eTrace;
  #offset = 0;
  readonly #messages: Message[] = [];
  #polling: Promise<void> | undefined;

  public constructor(
    peer: Bot,
    telexBotId: number,
    sendChatId: number | string,
    conversationChatId: number,
    trace: E2eTrace,
  ) {
    this.#peer = peer;
    this.#telexBotId = telexBotId;
    this.#sendChatId = sendChatId;
    this.#conversationChatId = conversationChatId;
    this.#trace = trace;
  }

  public get peerId(): number {
    return this.#peer.botInfo.id;
  }

  public conversationKey(threadId?: number): string {
    return `telegram:${this.#conversationChatId}:${threadId ?? 0}`;
  }

  public async drain(): Promise<void> {
    for (;;) {
      const updates = await this.#peer.api.getUpdates({
        offset: this.#offset,
        timeout: 0,
        limit: 100,
      });
      if (updates.length === 0) return;
      this.#offset = Math.max(...updates.map((update) => update.update_id)) + 1;
    }
  }

  public async sendText(text: string, threadId?: number): Promise<void> {
    await this.#trace.span("Peer bot sendMessage", async () => {
      await this.#peer.api.sendMessage(this.#sendChatId, text, threadParameters(threadId));
    });
  }

  public async sendVoice(path: string, caption: string, threadId?: number): Promise<void> {
    await this.#trace.span("Peer bot sendVoice", async () => {
      await this.#peer.api.sendVoice(this.#sendChatId, new InputFile(path), {
        caption,
        ...threadParameters(threadId),
      });
    });
  }

  public async waitFor(
    predicate: (message: Message) => boolean,
    timeoutMs = 300_000,
    label = "Wait for Telegram response",
  ): Promise<Message> {
    return await this.#trace.span(label, async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const buffered = this.#messages.findIndex(predicate);
        if (buffered >= 0) {
          const message = this.#messages.splice(buffered, 1)[0];
          if (message !== undefined) return message;
        }
        await this.pollUpdates(deadline);
      }
      throw new Error("Timed out waiting for the Telegram E2E response");
    });
  }

  private async pollUpdates(deadline: number): Promise<void> {
    const active = this.#polling;
    if (active !== undefined) {
      await active;
      return;
    }
    const polling = (async () => {
      const updates = await this.#peer.api.getUpdates({
        offset: this.#offset,
        timeout: Math.min(10, Math.max(1, Math.ceil((deadline - Date.now()) / 1_000))),
        limit: 100,
        allowed_updates: ["message"],
      });
      for (const update of updates) {
        this.#offset = Math.max(this.#offset, update.update_id + 1);
        const message = update.message;
        if (message?.from?.id === this.#telexBotId) this.#messages.push(message);
      }
    })();
    this.#polling = polling;
    try {
      await polling;
    } finally {
      if (this.#polling === polling) this.#polling = undefined;
    }
  }
}

export interface TelegramE2eSuiteOptions {
  readonly instance: TelegramE2eInstance;
  readonly clock: AdjustableE2eClock;
  readonly voiceFile: string;
  readonly expectedVoiceText: string;
  readonly parallelism: number;
}

export async function runTelegramE2eSuite(
  options: TelegramE2eSuiteOptions,
): Promise<readonly E2eScenarioResult[]> {
  const { driver, probe, telex } = options.instance;
  const threads = options.instance.threadIds;
  const requestedParallelism = validateE2eParallelism(options.parallelism);
  const effectiveParallelism =
    threads === undefined ? 1 : Math.min(requestedParallelism, threads.length);
  const threadForLane = (lane: number): number | undefined => threads?.[lane];
  const textThread = threadForLane(0);
  const text = await runE2eScenario(
    telex.trace,
    "Telegram text, reasoning, and activity",
    async () => {
      telex.trace.bindConversation(driver.conversationKey(textThread));
      await driver.sendText("Reply exactly TELEX_TELEGRAM_TEXT_OK.", textThread);
      try {
        await driver.waitFor(
          (message) =>
            inThread(message, textThread) &&
            messageText(message).includes("TELEX_TELEGRAM_TEXT_OK"),
          300_000,
          "Wait for Telegram text reply",
        );
      } catch (error) {
        throw new Error(
          `No Telegram response; Telex polls=${probe.count("getUpdates")}, inbound=${probe.sawUpdateFrom(driver.peerId)}, richDrafts=${probe.completedCount("sendRichMessageDraft")}/${probe.count("sendRichMessageDraft")}, plainDrafts=${probe.completedCount("sendMessageDraft")}/${probe.count("sendMessageDraft")}, typing=${probe.completedCount("sendChatAction")}/${probe.count("sendChatAction")}, richMessages=${probe.completedCount("sendRichMessage")}/${probe.count("sendRichMessage")}, messages=${probe.completedCount("sendMessage")}/${probe.count("sendMessage")}`,
          { cause: error },
        );
      }
      if (
        !probe.saw(["sendRichMessageDraft"], /thinking/u) &&
        !probe.saw(["sendMessageDraft", "sendChatAction"])
      ) {
        throw new Error("Telegram received neither rendered reasoning nor a typing activity call");
      }
    },
  );
  const compaction = await runE2eScenario(
    telex.trace,
    "Telegram manual context compaction",
    async () => {
      telex.trace.bindConversation(driver.conversationKey(textThread));
      await driver.sendText("/compact", textThread);
      await driver.waitFor(
        (message) =>
          inThread(message, textThread) && messageText(message).includes("Context compacted."),
        300_000,
        "Wait for Telegram context compaction",
      );
    },
  );
  if (!compaction.trace.some((entry) => entry.label === "Context compaction")) {
    throw new Error("Telegram did not observe the native context-compaction item");
  }

  const primary = await runE2eScenarios(telex.trace, effectiveParallelism, [
    {
      name: "Telegram voice download and transcription",
      run: async (lane) => {
        const threadId = threadForLane(lane);
        telex.trace.bindConversation(driver.conversationKey(threadId));
        await driver.sendVoice(
          options.voiceFile,
          `Reply TELEX_TELEGRAM_VOICE_OK only if the transcript contains: ${options.expectedVoiceText}`,
          threadId,
        );
        await driver.waitFor(
          (message) =>
            inThread(message, threadId) && messageText(message).includes("TELEX_TELEGRAM_VOICE_OK"),
          300_000,
          "Wait for Telegram voice reply",
        );
      },
    },
    {
      name: "Telegram generated image upload",
      run: async (lane) => {
        const threadId = threadForLane(lane);
        telex.trace.bindConversation(driver.conversationKey(threadId));
        await driver.sendText(
          "Generate a simple square blue triangle image with the image generation tool. Say TELEX_TELEGRAM_IMAGE_OK.",
          threadId,
        );
        await driver.waitFor(
          (message) =>
            inThread(message, threadId) && messageText(message).includes("TELEX_TELEGRAM_IMAGE_OK"),
          300_000,
          "Wait for Telegram image reply",
        );
        const attachment = await driver.waitFor(
          (message) =>
            inThread(message, threadId) &&
            ((message.photo?.length ?? 0) > 0 || message.document !== undefined),
          300_000,
          "Wait for Telegram image attachment",
        );
        if ((attachment.photo?.length ?? 0) === 0) {
          throw new Error("Telex generated image reached Telegram only as a document fallback");
        }
        if (!probe.saw(["sendPhoto"])) {
          throw new Error("Telex did not upload the image as a Telegram photo");
        }
      },
    },
    {
      name: "Telegram generated document upload",
      run: async (lane) => {
        const threadId = threadForLane(lane);
        telex.trace.bindConversation(driver.conversationKey(threadId));
        await driver.sendText(
          "Create a file named telex-e2e.txt containing TELEX_DOCUMENT_CONTENT, attach it, and say TELEX_TELEGRAM_DOCUMENT_OK.",
          threadId,
        );
        await driver.waitFor(
          (message) =>
            inThread(message, threadId) &&
            messageText(message).includes("TELEX_TELEGRAM_DOCUMENT_OK"),
          300_000,
          "Wait for Telegram document reply",
        );
        let document: Message;
        try {
          document = await driver.waitFor(
            (message) => inThread(message, threadId) && message.document !== undefined,
            60_000,
            "Wait for Telegram document attachment",
          );
        } catch (error) {
          throw new Error(
            `No Telegram document; sendDocument=${probe.completedCount("sendDocument")}/${probe.count("sendDocument")}`,
            { cause: error },
          );
        }
        if (document.document?.file_name !== "telex-e2e.txt" || !probe.saw(["sendDocument"])) {
          throw new Error("Telex did not attach the generated document with the expected name");
        }
      },
    },
    {
      name: "Telegram scheduler delivery",
      run: async (lane) => {
        const threadId = threadForLane(lane);
        telex.trace.bindConversation(driver.conversationKey(threadId));
        await driver.sendText(
          'Create a cron named "Telegram E2E" every minute that always notifies and asks: Reply TELEX_TELEGRAM_SCHEDULE_OK. Then say TELEGRAM_SCHEDULE_CREATED.',
          threadId,
        );
        await driver.waitFor(
          (message) =>
            inThread(message, threadId) &&
            messageText(message).includes("TELEGRAM_SCHEDULE_CREATED"),
          300_000,
          "Wait for Telegram schedule creation reply",
        );
        const owner: ProviderReference = {
          provider: "telegram",
          resource: "user",
          id: String(driver.peerId),
        };
        const conversation: ProviderReference = {
          provider: "telegram",
          resource: "conversation",
          id: driver.conversationKey(threadId),
        };
        if (telex.scheduler.listForConversation(owner, conversation).length !== 1) {
          throw new Error("Telegram channel did not bind the real schedule to its conversation");
        }
        await telex.codex.waitForIdle();
        options.clock.advance(2 * 60_000);
        await telex.trace.span("Scheduler tick and scheduled run", async () => {
          await telex.scheduler.tick();
          await telex.scheduler.waitForIdle();
        });
        await driver.waitFor(
          (message) =>
            inThread(message, threadId) &&
            messageText(message).includes("TELEX_TELEGRAM_SCHEDULE_OK"),
          300_000,
          "Wait for scheduled Telegram delivery",
        );
      },
    },
  ]);

  let isolation: E2eScenarioResult | undefined;
  if (threads !== undefined) {
    isolation = await runE2eScenario(telex.trace, "Telegram thread isolation", async () => {
      telex.trace.bindConversation(driver.conversationKey(threads[0]));
      telex.trace.bindConversation(driver.conversationKey(threads[1]));
      const sendAlpha = async () => {
        await driver.sendText("Reply exactly TELEGRAM_THREAD_ALPHA_OK.", threads[0]);
        return await driver.waitFor(
          (message) =>
            message.message_thread_id === threads[0] &&
            messageText(message).includes("TELEGRAM_THREAD_ALPHA_OK"),
          300_000,
          "Wait for Telegram alpha thread",
        );
      };
      const sendBeta = async () => {
        await driver.sendText("Reply exactly TELEGRAM_THREAD_BETA_OK.", threads[1]);
        return await driver.waitFor(
          (message) =>
            message.message_thread_id === threads[1] &&
            messageText(message).includes("TELEGRAM_THREAD_BETA_OK"),
          300_000,
          "Wait for Telegram beta thread",
        );
      };
      const [alpha, beta] =
        requestedParallelism === 1
          ? [await sendAlpha(), await sendBeta()]
          : await Promise.all([sendAlpha(), sendBeta()]);
      if (messageText(alpha).includes("BETA") || messageText(beta).includes("ALPHA")) {
        throw new Error("Telegram thread output crossed topic boundaries");
      }
    });
  }
  return [
    text,
    compaction,
    ...primary.slice(0, 3),
    ...(isolation === undefined ? [] : [isolation]),
    ...primary.slice(3),
  ];
}

function threadParameters(threadId: number | undefined): { message_thread_id?: number } {
  return threadId === undefined ? {} : { message_thread_id: threadId };
}

function messageText(message: Message): string {
  return message.text ?? message.caption ?? normalizeTelegramMessage(message).text;
}

function inThread(message: Message, threadId: number | undefined): boolean {
  return message.message_thread_id === threadId;
}
