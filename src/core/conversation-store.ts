import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteJson, ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";

const storedStateSchema = z.object({
  version: z.literal(1),
  conversations: z.record(z.string(), z.string().min(1)),
});

type StoredState = z.infer<typeof storedStateSchema>;

export class ConversationStore {
  readonly #conversations = new Map<string, string>();
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
      const parsed = storedStateSchema.parse(JSON.parse(await readFile(this.#path, "utf8")));
      this.#conversations.clear();
      for (const [key, threadId] of Object.entries(parsed.conversations)) {
        this.#conversations.set(key, threadId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#logger.warn("Ignoring invalid conversation state", { path: this.#path });
      }
    }
  }

  public get(conversationKey: string): string | undefined {
    return this.#conversations.get(conversationKey);
  }

  public async set(conversationKey: string, threadId: string): Promise<void> {
    this.#conversations.set(conversationKey, threadId);
    await this.persist();
  }

  public async delete(conversationKey: string): Promise<void> {
    this.#conversations.delete(conversationKey);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const state: StoredState = {
      version: 1,
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
