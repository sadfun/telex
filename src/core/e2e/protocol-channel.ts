import { readFile } from "node:fs/promises";
import { type Deferred, deferred, withTimeout } from "../../shared/async.js";
import type {
  ChoiceOption,
  DeliveryReceipt,
  InboundAttachment,
  MessageHandler,
  MessageResponder,
  MessagingChannel,
  OutboundAttachment,
  OutboundMessage,
  OutboundStream,
  ProgressSnapshot,
  ProviderReference,
} from "../channel.js";

export interface E2eExchange {
  readonly texts: readonly string[];
  readonly progress: readonly ProgressSnapshot[];
  readonly streamedText: string;
  readonly finalText: string;
  readonly attachments: readonly E2eCapturedAttachment[];
}

export interface E2eCapturedAttachment extends OutboundAttachment {
  /** Bytes consumed while the real turn attachment is still alive. */
  readonly content: Buffer;
}

export interface E2eInbound {
  readonly conversation?: string;
  readonly sender?: string;
  readonly text: string;
  readonly attachments?: readonly InboundAttachment[];
}

export interface E2ePublishedMessage {
  readonly target: ProviderReference;
  readonly message: OutboundMessage;
  readonly reference: ProviderReference;
}

class ProtocolResponder implements MessageResponder {
  readonly #texts: string[] = [];
  readonly #progress: ProgressSnapshot[] = [];
  #streamedText = "";
  #finalText = "";
  #attachments: readonly E2eCapturedAttachment[] = [];

  public createStream(): OutboundStream {
    return {
      start: async (initialProgress) => {
        if (initialProgress !== undefined) this.#progress.push(initialProgress);
      },
      setProgress: (progress) => this.#progress.push(progress),
      appendFinal: (delta) => {
        this.#streamedText += delta;
      },
      complete: async (text, attachments = []) => {
        this.#finalText = text;
        this.#attachments = await Promise.all(
          attachments.map(async (attachment) => ({
            ...attachment,
            content: await readFile(attachment.path),
          })),
        );
      },
      fail: async (message) => {
        this.#finalText = `Codex error: ${message}`;
      },
    };
  }

  public async sendText(text: string): Promise<void> {
    this.#texts.push(text);
  }

  public async askChoice(
    _prompt: string,
    options: readonly ChoiceOption[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted === true) return "decline";
    return options[0]?.id ?? "decline";
  }

  public snapshot(): E2eExchange {
    return {
      texts: this.#texts,
      progress: this.#progress,
      streamedText: this.#streamedText,
      finalText: this.#finalText,
      attachments: this.#attachments,
    };
  }
}

/** A real MessagingChannel whose transport is a direct protocol object. */
export class ProtocolE2eChannel implements MessagingChannel {
  public readonly name = "e2e";
  readonly #published: E2ePublishedMessage[] = [];
  readonly #waiters: Deferred<E2ePublishedMessage>[] = [];
  #handler: MessageHandler | undefined;
  #nextMessageId = 1;

  public async start(handler: MessageHandler): Promise<void> {
    this.#handler = handler;
  }

  public async stop(): Promise<void> {
    this.#handler = undefined;
  }

  public isAuthorized(principal: ProviderReference): boolean {
    return principal.provider === this.name && principal.resource === "user";
  }

  public async send(input: E2eInbound): Promise<E2eExchange> {
    const handler = this.#handler;
    if (handler === undefined) throw new Error("The E2E channel is not started");
    const conversation = input.conversation ?? "main";
    const sender = input.sender ?? "operator";
    const id = String(this.#nextMessageId++);
    const responder = new ProtocolResponder();
    await handler({
      id,
      address: {
        channel: this.name,
        key: `${this.name}:${conversation}`,
        isPrivate: true,
        isGuest: false,
        deliveryTarget: {
          provider: this.name,
          resource: "destination",
          id: conversation,
        },
      },
      reference: { provider: this.name, resource: "message", id },
      sender: { id: sender, displayName: sender },
      text: input.text,
      attachments: input.attachments ?? [],
      responder,
    });
    return responder.snapshot();
  }

  public async publish(
    target: ProviderReference,
    message: OutboundMessage,
  ): Promise<DeliveryReceipt> {
    const reference = {
      provider: this.name,
      resource: "message" as const,
      id: `published:${this.#nextMessageId++}`,
    };
    const published = { target, message, reference };
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#published.push(published);
    else waiter.resolve(published);
    return { publishedMessages: [reference] };
  }

  public async nextPublished(timeoutMs = 180_000): Promise<E2ePublishedMessage> {
    const existing = this.#published.shift();
    if (existing !== undefined) return existing;
    const waiter = deferred<E2ePublishedMessage>();
    this.#waiters.push(waiter);
    try {
      return await withTimeout(
        waiter.promise,
        timeoutMs,
        "Timed out waiting for a published E2E message",
      );
    } finally {
      const index = this.#waiters.indexOf(waiter);
      if (index >= 0) this.#waiters.splice(index, 1);
    }
  }
}
