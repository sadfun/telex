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
import type { AdjustableE2eClock, E2eScenarioResult } from "../../core/e2e/suite.js";
import { delay } from "../../shared/async.js";
import { TelegramChannel } from "./channel.js";

interface TelegramApiCall {
  readonly method: string;
  readonly body: string;
}

/** Transparent recorder: every request still executes against the real Telegram Bot API. */
export class TelegramApiProbe {
  readonly #calls: TelegramApiCall[] = [];
  readonly #server = createServer((request, response) => {
    void this.forward(request, response);
  });
  #baseUrl: string | undefined;

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

  public async stop(): Promise<void> {
    if (!this.#server.listening) return;
    this.#server.close();
    await once(this.#server, "close");
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const path = request.url ?? "/";
      const method = /^\/bot[^/]+\/([^/?]+)/u.exec(path)?.[1] ?? "file";
      const contentType = String(request.headers["content-type"] ?? "");
      const inspectable = /json|urlencoded|multipart/u.test(contentType)
        ? body.subarray(0, 128 * 1_024).toString("utf8")
        : "";
      this.#calls.push({ method, body: inspectable });
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name === "host" || name === "content-length") continue;
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
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      response.statusCode = 502;
      response.end(
        (error instanceof Error ? error.message : String(error)).replaceAll(
          /bot[0-9]{6,12}:[A-Za-z0-9_-]{30,}/gu,
          "bot<redacted>",
        ),
      );
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
  /** Destination used by the peer; direct bot-to-bot mode defaults to the Telex bot ID. */
  readonly chatId?: number;
  /** Two real forum/topic IDs enable the parallel-thread scenario. */
  readonly threadIds?: readonly [number, number];
}

export class TelegramE2eInstance {
  public readonly telex: E2eTelexInstance;
  public readonly driver: TelegramE2eDriver;
  public readonly probe: TelegramApiProbe;
  public readonly threadIds: readonly [number, number] | undefined;

  public constructor(options: {
    telex: E2eTelexInstance;
    driver: TelegramE2eDriver;
    probe: TelegramApiProbe;
    threadIds?: readonly [number, number];
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
  const probe = new TelegramApiProbe();
  await probe.start();
  try {
    const telexBot = new Bot(options.telexBotToken);
    const peerBot = new Bot(options.peerBotToken);
    await Promise.all([telexBot.init(), peerBot.init()]);
    if (telexBot.botInfo.id === peerBot.botInfo.id)
      throw new Error("E2E requires two different bots");
    const driver = new TelegramE2eDriver(
      peerBot,
      telexBot.botInfo.id,
      options.chatId ?? telexBot.botInfo.id,
      options.chatId ?? peerBot.botInfo.id,
    );
    await driver.drain();
    const launchOptions = {
      requestToken: options.requestToken,
      ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
      ...(options.codexBinaryPath === undefined
        ? {}
        : { codexBinaryPath: options.codexBinaryPath }),
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
  readonly #sendChatId: number;
  readonly #conversationChatId: number;
  #offset = 0;
  readonly #messages: Message[] = [];

  public constructor(
    peer: Bot,
    telexBotId: number,
    sendChatId: number,
    conversationChatId: number,
  ) {
    this.#peer = peer;
    this.#telexBotId = telexBotId;
    this.#sendChatId = sendChatId;
    this.#conversationChatId = conversationChatId;
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
    await this.#peer.api.sendMessage(this.#sendChatId, text, threadParameters(threadId));
  }

  public async sendVoice(path: string, caption: string, threadId?: number): Promise<void> {
    await this.#peer.api.sendVoice(this.#sendChatId, new InputFile(path), {
      caption,
      ...threadParameters(threadId),
    });
  }

  public async waitFor(
    predicate: (message: Message) => boolean,
    timeoutMs = 300_000,
  ): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const buffered = this.#messages.findIndex(predicate);
      if (buffered >= 0) {
        const message = this.#messages.splice(buffered, 1)[0];
        if (message !== undefined) return message;
      }
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
    }
    throw new Error("Timed out waiting for the Telegram E2E response");
  }
}

export interface TelegramE2eSuiteOptions {
  readonly instance: TelegramE2eInstance;
  readonly clock: AdjustableE2eClock;
  readonly voiceFile: string;
  readonly expectedVoiceText: string;
}

export async function runTelegramE2eSuite(
  options: TelegramE2eSuiteOptions,
): Promise<readonly E2eScenarioResult[]> {
  const { driver, probe, telex } = options.instance;
  const results: E2eScenarioResult[] = [];
  await scenario(results, "Telegram text, reasoning, and activity", async () => {
    await driver.sendText("Think through this, then reply with TELEX_TELEGRAM_TEXT_OK.");
    await driver.waitFor((message) => messageText(message).includes("TELEX_TELEGRAM_TEXT_OK"));
    if (
      !probe.saw(["sendRichMessageDraft"], /thinking/u) &&
      !probe.saw(["sendMessageDraft", "sendChatAction"])
    ) {
      throw new Error("Telegram received neither rendered reasoning nor a typing activity call");
    }
  });
  await scenario(results, "Telegram voice download and transcription", async () => {
    await driver.sendVoice(
      options.voiceFile,
      `Reply TELEX_TELEGRAM_VOICE_OK only if the transcript contains: ${options.expectedVoiceText}`,
    );
    await driver.waitFor((message) => messageText(message).includes("TELEX_TELEGRAM_VOICE_OK"));
  });
  await scenario(results, "Telegram generated image upload", async () => {
    await driver.sendText(
      "Generate a simple square blue triangle image with the image generation tool. Say TELEX_TELEGRAM_IMAGE_OK.",
    );
    await driver.waitFor((message) => messageText(message).includes("TELEX_TELEGRAM_IMAGE_OK"));
    await driver.waitFor((message) => (message.photo?.length ?? 0) > 0);
    if (!probe.saw(["sendPhoto"]))
      throw new Error("Telex did not upload the image as a Telegram photo");
  });
  await scenario(results, "Telegram generated document upload", async () => {
    await driver.sendText(
      "Create a file named telex-e2e.txt containing TELEX_DOCUMENT_CONTENT, attach it, and say TELEX_TELEGRAM_DOCUMENT_OK.",
    );
    const document = await driver.waitFor((message) => message.document !== undefined);
    await driver.waitFor((message) => messageText(message).includes("TELEX_TELEGRAM_DOCUMENT_OK"));
    if (document.document?.file_name !== "telex-e2e.txt" || !probe.saw(["sendDocument"])) {
      throw new Error("Telex did not attach the generated document with the expected name");
    }
  });
  const threads = options.instance.threadIds;
  if (threads !== undefined) {
    await scenario(results, "Telegram parallel thread isolation", async () => {
      await Promise.all([
        driver.sendText("Reply exactly TELEGRAM_THREAD_ALPHA_OK.", threads[0]),
        driver.sendText("Reply exactly TELEGRAM_THREAD_BETA_OK.", threads[1]),
      ]);
      const alpha = await driver.waitFor(
        (message) =>
          message.message_thread_id === threads[0] &&
          messageText(message).includes("TELEGRAM_THREAD_ALPHA_OK"),
      );
      const beta = await driver.waitFor(
        (message) =>
          message.message_thread_id === threads[1] &&
          messageText(message).includes("TELEGRAM_THREAD_BETA_OK"),
      );
      if (messageText(alpha).includes("BETA") || messageText(beta).includes("ALPHA")) {
        throw new Error("Telegram thread output crossed topic boundaries");
      }
    });
  }
  await scenario(results, "Telegram scheduler delivery", async () => {
    await driver.sendText(
      'Create a cron named "Telegram E2E" every minute that always notifies and asks: Reply TELEX_TELEGRAM_SCHEDULE_OK. Then say TELEGRAM_SCHEDULE_CREATED.',
    );
    await driver.waitFor((message) => messageText(message).includes("TELEGRAM_SCHEDULE_CREATED"));
    const owner: ProviderReference = {
      provider: "telegram",
      resource: "user",
      id: String(driver.peerId),
    };
    const conversation: ProviderReference = {
      provider: "telegram",
      resource: "conversation",
      id: driver.conversationKey(),
    };
    if (telex.scheduler.listForConversation(owner, conversation).length !== 1) {
      throw new Error("Telegram channel did not bind the real schedule to its conversation");
    }
    options.clock.advance(2 * 60_000);
    await telex.scheduler.tick();
    await telex.scheduler.waitForIdle();
    await driver.waitFor((message) => messageText(message).includes("TELEX_TELEGRAM_SCHEDULE_OK"));
  });
  return results;
}

function threadParameters(threadId: number | undefined): { message_thread_id?: number } {
  return threadId === undefined ? {} : { message_thread_id: threadId };
}

function messageText(message: Message): string {
  return message.text ?? message.caption ?? "";
}

async function scenario(
  results: E2eScenarioResult[],
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  await run();
  results.push({ name, durationMs: Date.now() - startedAt });
  await delay(250);
}
