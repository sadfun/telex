import { z } from "zod";
import { JsonStore } from "../shared/json-store.js";
import type { Logger } from "../shared/logger.js";

const conversationStateSchema = z.object({
  activeThreadId: z.string().min(1),
  previousThreadIds: z.array(z.string().min(1)).max(10),
});

const storedStateSchema = z.object({
  version: z.literal(2),
  conversations: z.record(z.string(), conversationStateSchema),
});

type StoredState = z.infer<typeof storedStateSchema>;

export class ConversationStore extends JsonStore<StoredState> {
  static readonly #historyLimit = 10;

  public constructor(path: string, logger: Logger) {
    super(
      path,
      storedStateSchema,
      { version: 2, conversations: {} },
      logger,
      "Ignoring invalid conversation state",
    );
  }

  public get(conversationKey: string): string | undefined {
    return this.state.conversations[conversationKey]?.activeThreadId;
  }

  public previous(conversationKey: string): string | undefined {
    return this.state.conversations[conversationKey]?.previousThreadIds[0];
  }

  public async set(conversationKey: string, threadId: string): Promise<void> {
    const existing = this.state.conversations[conversationKey];
    await this.put(conversationKey, {
      activeThreadId: threadId,
      previousThreadIds: existing?.previousThreadIds ?? [],
    });
  }

  public async switchTo(conversationKey: string, threadId: string): Promise<boolean> {
    const existing = this.state.conversations[conversationKey];
    if (existing?.activeThreadId === threadId) return false;
    const previousThreadIds =
      existing === undefined
        ? []
        : [
            existing.activeThreadId,
            ...existing.previousThreadIds.filter((candidate) => candidate !== threadId),
          ].slice(0, ConversationStore.#historyLimit);
    await this.put(conversationKey, { activeThreadId: threadId, previousThreadIds });
    return true;
  }

  public async delete(conversationKey: string): Promise<void> {
    const conversations = Object.fromEntries(
      Object.entries(this.state.conversations).filter(([key]) => key !== conversationKey),
    );
    await this.persist({ version: 2, conversations });
  }

  private async put(
    conversationKey: string,
    conversation: StoredState["conversations"][string],
  ): Promise<void> {
    await this.persist({
      version: 2,
      conversations: { ...this.state.conversations, [conversationKey]: conversation },
    });
  }
}
