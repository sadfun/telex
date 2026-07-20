import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteJson, ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";

const legacyStoredStateSchema = z.object({
  version: z.literal(1),
  conversations: z.record(z.string(), z.string().min(1)),
});

const conversationStateSchema = z.object({
  activeThreadId: z.string().min(1),
  previousThreadIds: z.array(z.string().min(1)).max(10),
});

const storedStateSchema = z.object({
  version: z.literal(2),
  conversations: z.record(z.string(), conversationStateSchema),
});

type ConversationState = z.infer<typeof conversationStateSchema>;
type StoredState = z.infer<typeof storedStateSchema>;

export class ConversationStore {
  static readonly #historyLimit = 10;
  readonly #conversations = new Map<string, ConversationState>();
  readonly #path: string;
  readonly #logger: Logger;
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(path: string, logger: Logger) {
    this.#path = path;
    this.#logger = logger;
  }

  public async load(): Promise<void> {
    await ensureDirectory(dirname(this.#path));
    try {
      const raw = JSON.parse(await readFile(this.#path, "utf8"));
      const parsed = z.union([storedStateSchema, legacyStoredStateSchema]).parse(raw);
      this.#conversations.clear();
      if (parsed.version === 1) {
        for (const [key, threadId] of Object.entries(parsed.conversations)) {
          this.#conversations.set(key, { activeThreadId: threadId, previousThreadIds: [] });
        }
      } else {
        for (const [key, state] of Object.entries(parsed.conversations)) {
          this.#conversations.set(key, state);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#logger.warn("Ignoring invalid conversation state", { path: this.#path });
      }
    }
  }

  public get(conversationKey: string): string | undefined {
    return this.#conversations.get(conversationKey)?.activeThreadId;
  }

  public previous(conversationKey: string): string | undefined {
    return this.#conversations.get(conversationKey)?.previousThreadIds[0];
  }

  public async set(conversationKey: string, threadId: string): Promise<void> {
    const existing = this.#conversations.get(conversationKey);
    this.#conversations.set(conversationKey, {
      activeThreadId: threadId,
      previousThreadIds: existing?.previousThreadIds ?? [],
    });
    await this.persist();
  }

  public async switchTo(conversationKey: string, threadId: string): Promise<boolean> {
    const existing = this.#conversations.get(conversationKey);
    if (existing?.activeThreadId === threadId) return false;
    const previousThreadIds =
      existing === undefined
        ? []
        : [
            existing.activeThreadId,
            ...existing.previousThreadIds.filter((candidate) => candidate !== threadId),
          ].slice(0, ConversationStore.#historyLimit);
    this.#conversations.set(conversationKey, {
      activeThreadId: threadId,
      previousThreadIds,
    });
    await this.persist();
    return true;
  }

  public async back(conversationKey: string): Promise<string | undefined> {
    const existing = this.#conversations.get(conversationKey);
    const previous = existing?.previousThreadIds[0];
    if (existing === undefined || previous === undefined) return undefined;
    this.#conversations.set(conversationKey, {
      activeThreadId: previous,
      previousThreadIds: [
        existing.activeThreadId,
        ...existing.previousThreadIds.slice(1).filter((candidate) => candidate !== previous),
      ].slice(0, ConversationStore.#historyLimit),
    });
    await this.persist();
    return previous;
  }

  public async delete(conversationKey: string): Promise<void> {
    this.#conversations.delete(conversationKey);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const state: StoredState = {
      version: 2,
      conversations: Object.fromEntries(this.#conversations),
    };
    this.#writeTail = this.#writeTail
      .catch(() => undefined)
      .then(async () => {
        await atomicWriteJson(this.#path, state);
      });
    await this.#writeTail;
  }
}
