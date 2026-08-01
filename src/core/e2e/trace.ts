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
  #scenario: TraceScope | undefined;

  public beginScenario(name: string): void {
    if (this.#scenario !== undefined) throw new Error(`E2E trace scenario is already active`);
    this.#scenario = { name, startedAt: performance.now(), entries: [] };
  }

  public finishScenario(name: string): readonly E2eTraceEntry[] {
    const scope = this.#scenario;
    if (scope?.name !== name) throw new Error(`E2E trace scenario mismatch: ${name}`);
    this.#scenario = undefined;
    return sorted(scope.entries);
  }

  public startup(): readonly E2eTraceEntry[] {
    return sorted(this.#startup.entries);
  }

  public start(label: string, detail?: string): () => void {
    const scope = this.#scenario;
    if (scope === undefined) return () => undefined;
    return startSpan(scope, label, detail);
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
}

export function attachCodexE2eTrace(rpc: CodexAppServer, trace: E2eTrace): () => void {
  const spans = new Map<string, () => void>();
  return rpc.onNotification((notification) => {
    switch (notification.method) {
      case "turn/started": {
        const turn = notification.params.turn;
        spans.set(`turn:${turn.id}`, trace.start("Codex turn", shortId(turn.id)));
        return;
      }
      case "turn/completed": {
        const turn = notification.params.turn;
        finishOrMark(spans, `turn:${turn.id}`, trace, "Codex turn", shortId(turn.id));
        return;
      }
      case "item/started": {
        const item = notification.params.item;
        const label = tracedItemLabel(item);
        if (label !== undefined) {
          spans.set(`item:${item.id}`, trace.start(label, shortId(notification.params.turnId)));
        }
        return;
      }
      case "item/completed": {
        const item = notification.params.item;
        const label = tracedItemLabel(item);
        if (label !== undefined) {
          finishOrMark(spans, `item:${item.id}`, trace, label, shortId(notification.params.turnId));
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

function finishOrMark(
  spans: Map<string, () => void>,
  key: string,
  trace: E2eTrace,
  label: string,
  detail?: string,
): void {
  const finish = spans.get(key);
  spans.delete(key);
  if (finish === undefined) trace.start(label, detail)();
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
