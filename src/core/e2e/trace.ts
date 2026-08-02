import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { CodexAppServer } from "../../codex/rpc.js";
import type { ThreadItem } from "../../generated/codex/v2/ThreadItem.js";

export interface E2eTraceEntry {
  readonly label: string;
  readonly detail?: string;
  readonly startMs: number;
  readonly durationMs: number;
}

interface TraceScope {
  readonly name: string;
  readonly startedAt: number;
  readonly entries: E2eTraceEntry[];
}

/** Passive wall-clock spans around real E2E operations and Codex protocol events. */
export class E2eTrace {
  readonly #startup: TraceScope = { name: "startup", startedAt: performance.now(), entries: [] };
  readonly #background: TraceScope = {
    name: "shared concurrent events",
    startedAt: this.#startup.startedAt,
    entries: [],
  };
  readonly #scenario = new AsyncLocalStorage<TraceScope>();
  readonly #conversationScopes = new Map<string, TraceScope>();
  readonly #threadScopes = new Map<string, TraceScope>();
  readonly #turnScopes = new Map<string, TraceScope>();

  public async runScenario<T>(
    name: string,
    run: () => Promise<T>,
  ): Promise<{ readonly result: T; readonly trace: readonly E2eTraceEntry[] }> {
    const scope: TraceScope = { name, startedAt: performance.now(), entries: [] };
    const result = await this.#scenario.run(scope, run);
    return { result, trace: sorted(scope.entries) };
  }

  public startup(): readonly E2eTraceEntry[] {
    return sorted(this.#startup.entries);
  }

  public background(): readonly E2eTraceEntry[] {
    return sorted(this.#background.entries);
  }

  public start(label: string, detail?: string): () => void {
    return startSpan(this.#scenario.getStore() ?? this.#background, label, detail);
  }

  public startStartup(label: string, detail?: string): () => void {
    return startSpan(this.#startup, label, detail);
  }

  public async span<T>(label: string, run: () => Promise<T>, detail?: string): Promise<T> {
    const finish = this.start(label, detail);
    try {
      return await run();
    } finally {
      finish();
    }
  }

  public async startupSpan<T>(label: string, run: () => Promise<T>, detail?: string): Promise<T> {
    const finish = this.startStartup(label, detail);
    try {
      return await run();
    } finally {
      finish();
    }
  }

  /** Bind an external channel conversation before its update reaches Telex asynchronously. */
  public bindConversation(conversationKey: string): void {
    const scope = this.#scenario.getStore();
    if (scope !== undefined) this.#conversationScopes.set(conversationKey, scope);
  }

  /** Bind a real Codex thread to the scenario that is about to start a turn on it. */
  public bindThread(threadId: string, conversationKey: string): void {
    const scope = this.#scenario.getStore() ?? this.#conversationScopes.get(conversationKey);
    if (scope !== undefined) this.#threadScopes.set(threadId, scope);
  }

  public startCodexTurn(threadId: string, turnId: string): () => void {
    const scope = this.#threadScopes.get(threadId) ?? this.#background;
    this.#turnScopes.set(turnId, scope);
    const finish = startSpan(scope, "Codex turn", shortId(turnId));
    return () => {
      finish();
      this.#turnScopes.delete(turnId);
    };
  }

  public startCodexItem(turnId: string, label: string): () => void {
    return startSpan(this.#turnScopes.get(turnId) ?? this.#background, label, shortId(turnId));
  }
}

export function attachCodexE2eTrace(rpc: CodexAppServer, trace: E2eTrace): () => void {
  const spans = new Map<string, () => void>();
  return rpc.onNotification((notification) => {
    switch (notification.method) {
      case "turn/started": {
        const turn = notification.params.turn;
        spans.set(`turn:${turn.id}`, trace.startCodexTurn(notification.params.threadId, turn.id));
        return;
      }
      case "turn/completed": {
        const turn = notification.params.turn;
        finishOrMark(spans, `turn:${turn.id}`, () =>
          trace.startCodexTurn(notification.params.threadId, turn.id),
        );
        return;
      }
      case "item/started": {
        const item = notification.params.item;
        const label = tracedItemLabel(item);
        if (label !== undefined) {
          spans.set(`item:${item.id}`, trace.startCodexItem(notification.params.turnId, label));
        }
        return;
      }
      case "item/completed": {
        const item = notification.params.item;
        const label = tracedItemLabel(item);
        if (label !== undefined) {
          finishOrMark(spans, `item:${item.id}`, () =>
            trace.startCodexItem(notification.params.turnId, label),
          );
        }
        return;
      }
      default:
        return;
    }
  });
}

function startSpan(scope: TraceScope, label: string, detail?: string): () => void {
  const startedAt = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    scope.entries.push({
      label,
      ...(detail === undefined ? {} : { detail }),
      startMs: startedAt - scope.startedAt,
      durationMs: performance.now() - startedAt,
    });
  };
}

function finishOrMark(spans: Map<string, () => void>, key: string, start: () => () => void): void {
  const finish = spans.get(key);
  spans.delete(key);
  if (finish === undefined) start()();
  else finish();
}

function tracedItemLabel(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "reasoning":
      return "Model reasoning";
    case "agentMessage":
      return item.phase === "commentary" ? "Model commentary" : "Model final answer";
    case "imageGeneration":
      return "Image generation tool";
    case "dynamicToolCall":
      return `Dynamic tool ${item.namespace === null ? "" : `${item.namespace}.`}${item.tool}`;
    case "mcpToolCall":
      return `MCP tool ${item.server}.${item.tool}`;
    case "commandExecution":
      return "Command execution";
    case "fileChange":
      return "File change";
    case "webSearch":
      return "Web search";
    case "sleep":
      return "Codex sleep";
    default:
      return undefined;
  }
}

function sorted(entries: readonly E2eTraceEntry[]): readonly E2eTraceEntry[] {
  return entries.toSorted((left, right) => left.startMs - right.startMs);
}

function shortId(value: string): string {
  return value.slice(0, 8);
}
