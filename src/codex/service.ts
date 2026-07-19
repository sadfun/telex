import { basename } from "node:path";
import type {
  ChoiceOption,
  MessageResponder,
  OutboundStream,
  ProgressAction,
  ProgressPlanStep,
  ProgressSnapshot,
} from "../core/channel.js";
import type { ConversationStore } from "../core/conversation-store.js";
import type { ServerNotification } from "../generated/codex/ServerNotification.js";
import type { ServerRequest } from "../generated/codex/ServerRequest.js";
import type { AccountLoginCompletedNotification } from "../generated/codex/v2/AccountLoginCompletedNotification.js";
import type { AgentMessageDeltaNotification } from "../generated/codex/v2/AgentMessageDeltaNotification.js";
import type { CommandExecutionRequestApprovalResponse } from "../generated/codex/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangePatchUpdatedNotification } from "../generated/codex/v2/FileChangePatchUpdatedNotification.js";
import type { FileChangeRequestApprovalResponse } from "../generated/codex/v2/FileChangeRequestApprovalResponse.js";
import type { FileUpdateChange } from "../generated/codex/v2/FileUpdateChange.js";
import type { GetAccountResponse } from "../generated/codex/v2/GetAccountResponse.js";
import type { ItemCompletedNotification } from "../generated/codex/v2/ItemCompletedNotification.js";
import type { ItemStartedNotification } from "../generated/codex/v2/ItemStartedNotification.js";
import type { LoginAccountResponse } from "../generated/codex/v2/LoginAccountResponse.js";
import type { PermissionsRequestApprovalResponse } from "../generated/codex/v2/PermissionsRequestApprovalResponse.js";
import type { ReasoningSummaryTextDeltaNotification } from "../generated/codex/v2/ReasoningSummaryTextDeltaNotification.js";
import type { ThreadItem } from "../generated/codex/v2/ThreadItem.js";
import type { ThreadResumeResponse } from "../generated/codex/v2/ThreadResumeResponse.js";
import type { ThreadStartResponse } from "../generated/codex/v2/ThreadStartResponse.js";
import type { ToolRequestUserInputAnswer } from "../generated/codex/v2/ToolRequestUserInputAnswer.js";
import type { ToolRequestUserInputResponse } from "../generated/codex/v2/ToolRequestUserInputResponse.js";
import type { Turn } from "../generated/codex/v2/Turn.js";
import type { TurnCompletedNotification } from "../generated/codex/v2/TurnCompletedNotification.js";
import type { TurnInterruptResponse } from "../generated/codex/v2/TurnInterruptResponse.js";
import type { TurnPlanUpdatedNotification } from "../generated/codex/v2/TurnPlanUpdatedNotification.js";
import type { TurnStartResponse } from "../generated/codex/v2/TurnStartResponse.js";
import { type Deferred, deferred, KeyedSerialQueue, withTimeout } from "../shared/async.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { CodexAppServer } from "./rpc.js";

interface ActiveTurn {
  readonly conversationKey: string;
  readonly threadId: string;
  readonly responder: MessageResponder;
  readonly stream: OutboundStream;
  readonly completion: Deferred<Turn>;
  readonly phases: Map<string, "commentary" | "final_answer" | null>;
  readonly actions: Map<string, readonly ProgressAction[]>;
  readonly reasoning: Map<string, readonly string[]>;
  progressMessage: string;
  plan: readonly ProgressPlanStep[];
  finalText: string;
  turnId: string | undefined;
}

export class CodexService {
  readonly #queue = new KeyedSerialQueue();
  readonly #activeByThread = new Map<string, ActiveTurn>();
  readonly #activeByConversation = new Map<string, ActiveTurn>();
  readonly #loadedThreads = new Set<string>();
  readonly #rpc: CodexAppServer;
  readonly #conversations: ConversationStore;
  readonly #workspace: string;
  readonly #logger: Logger;

  public constructor(
    rpc: CodexAppServer,
    conversations: ConversationStore,
    workspace: string,
    logger: Logger,
  ) {
    this.#rpc = rpc;
    this.#conversations = conversations;
    this.#workspace = workspace;
    this.#logger = logger;
    rpc.onNotification((notification) => this.handleNotification(notification));
    rpc.setServerRequestHandler(async (request) => await this.handleServerRequest(request));
  }

  public async runTurn(
    conversationKey: string,
    text: string,
    responder: MessageResponder,
    ephemeral = false,
  ): Promise<void> {
    await this.#queue.run(conversationKey, async () => {
      const stream = responder.createStream();
      await stream.start();
      let active: ActiveTurn | undefined;
      try {
        const threadId = await this.ensureThread(conversationKey, ephemeral);
        active = {
          conversationKey,
          threadId,
          responder,
          stream,
          completion: deferred<Turn>(),
          phases: new Map(),
          actions: new Map(),
          reasoning: new Map(),
          progressMessage: "",
          plan: [],
          finalText: "",
          turnId: undefined,
        };
        this.#activeByThread.set(threadId, active);
        this.#activeByConversation.set(conversationKey, active);

        const response = await this.#rpc.request<TurnStartResponse>({
          method: "turn/start",
          params: {
            threadId,
            clientUserMessageId: crypto.randomUUID(),
            input: [{ type: "text", text, text_elements: [] }],
          },
        });
        active.turnId = response.turn.id;
        const turn = await withTimeout(
          active.completion.promise,
          30 * 60 * 1_000,
          "Codex turn did not complete within 30 minutes",
        );
        if (turn.status === "failed") {
          throw new BridgeError(turn.error?.message ?? "Codex turn failed", "CODEX_TURN_FAILED");
        }

        const finalText = this.finalTextFromTurn(turn) || active.finalText;
        if (turn.status === "interrupted" && finalText.length === 0) {
          await stream.complete("Stopped.");
        } else {
          await stream.complete(finalText || "Done.");
        }
      } catch (error) {
        this.#logger.error("Codex turn failed", error, { conversationKey });
        await stream.fail(errorMessage(error));
      } finally {
        if (active !== undefined) {
          this.#activeByThread.delete(active.threadId);
          this.#activeByConversation.delete(conversationKey);
        }
      }
    });
  }

  public async resetConversation(conversationKey: string): Promise<void> {
    await this.interrupt(conversationKey);
    await this.#conversations.delete(conversationKey);
  }

  public async interrupt(conversationKey: string): Promise<boolean> {
    const active = this.#activeByConversation.get(conversationKey);
    if (active?.turnId === undefined) return false;
    await this.#rpc.request<TurnInterruptResponse>({
      method: "turn/interrupt",
      params: { threadId: active.threadId, turnId: active.turnId },
    });
    return true;
  }

  public async account(): Promise<GetAccountResponse> {
    return await this.#rpc.request<GetAccountResponse>({
      method: "account/read",
      params: { refreshToken: false },
    });
  }

  public async startDeviceLogin(): Promise<LoginAccountResponse> {
    return await this.#rpc.request<LoginAccountResponse>({
      method: "account/login/start",
      params: { type: "chatgptDeviceCode" },
    });
  }

  public async logout(): Promise<void> {
    await this.#rpc.request<unknown>({ method: "account/logout", params: undefined });
  }

  private async ensureThread(conversationKey: string, ephemeral: boolean): Promise<string> {
    if (!ephemeral) {
      const stored = this.#conversations.get(conversationKey);
      if (stored !== undefined) {
        if (!this.#loadedThreads.has(stored)) {
          try {
            const resumed = await this.#rpc.request<ThreadResumeResponse>({
              method: "thread/resume",
              params: { threadId: stored, cwd: this.#workspace },
            });
            this.#loadedThreads.add(resumed.thread.id);
            return resumed.thread.id;
          } catch (error) {
            this.#logger.warn("Stored Codex thread could not be resumed; starting a new thread", {
              conversationKey,
              error: errorMessage(error),
            });
            await this.#conversations.delete(conversationKey);
          }
        } else {
          return stored;
        }
      }
    }

    const started = await this.#rpc.request<ThreadStartResponse>({
      method: "thread/start",
      params: {
        cwd: this.#workspace,
        ephemeral,
        serviceName: "telex",
        threadSource: "telex",
      },
    });
    this.#loadedThreads.add(started.thread.id);
    if (!ephemeral) await this.#conversations.set(conversationKey, started.thread.id);
    return started.thread.id;
  }

  private handleNotification(notification: ServerNotification): void {
    switch (notification.method) {
      case "item/started":
        this.handleItemStarted(notification.params);
        break;
      case "item/completed":
        this.handleItemCompleted(notification.params);
        break;
      case "item/agentMessage/delta":
        this.handleAgentDelta(notification.params);
        break;
      case "item/reasoning/summaryTextDelta":
        this.handleReasoningDelta(notification.params);
        break;
      case "item/fileChange/patchUpdated":
        this.handleFileChangeUpdated(notification.params);
        break;
      case "turn/plan/updated":
        this.handlePlanUpdated(notification.params);
        break;
      case "turn/completed":
        this.handleTurnCompleted(notification.params);
        break;
      case "account/login/completed":
        this.handleLoginCompleted(notification.params);
        break;
      case "error":
        this.#logger.warn("Codex reported an error notification", {
          codexMessage: notification.params.error.message,
        });
        break;
      default:
        break;
    }
  }

  private handleItemStarted(notification: ItemStartedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined) return;
    if (notification.item.type === "agentMessage") {
      active.phases.set(notification.item.id, notification.item.phase);
      if (notification.item.phase === "commentary") {
        active.progressMessage = notification.item.text;
      }
    }
    if (notification.item.type === "reasoning") {
      active.reasoning.set(notification.item.id, notification.item.summary);
    }
    this.updateItemActions(active, notification.item);
  }

  private handleItemCompleted(notification: ItemCompletedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined) return;
    if (notification.item.type === "agentMessage") {
      active.phases.set(notification.item.id, notification.item.phase);
      if (notification.item.phase === "commentary") {
        active.progressMessage = notification.item.text;
      }
    }
    if (notification.item.type === "reasoning") {
      active.reasoning.set(notification.item.id, notification.item.summary);
    }
    this.updateItemActions(active, notification.item);
  }

  private handleAgentDelta(notification: AgentMessageDeltaNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined) return;
    if (active.phases.get(notification.itemId) === "commentary") {
      active.progressMessage += notification.delta;
      this.publishProgress(active);
    } else {
      active.finalText += notification.delta;
      active.stream.appendFinal(notification.delta);
    }
  }

  private handleReasoningDelta(notification: ReasoningSummaryTextDeltaNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined) return;
    const summaries = [...(active.reasoning.get(notification.itemId) ?? [])];
    summaries[notification.summaryIndex] =
      `${summaries[notification.summaryIndex] ?? ""}${notification.delta}`;
    active.reasoning.set(notification.itemId, summaries);
    this.publishProgress(active);
  }

  private handleFileChangeUpdated(notification: FileChangePatchUpdatedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined) return;
    active.actions.set(notification.itemId, fileChangeActions(notification.changes, false));
    this.publishProgress(active);
  }

  private handlePlanUpdated(notification: TurnPlanUpdatedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined) return;
    active.plan = notification.plan;
    this.publishProgress(active);
  }

  private updateItemActions(active: ActiveTurn, item: ThreadItem): void {
    const actions = progressActions(item);
    if (actions.length > 0) active.actions.set(item.id, actions);
    this.publishProgress(active);
  }

  private publishProgress(active: ActiveTurn): void {
    const summary = Array.from(active.reasoning.values())
      .reverse()
      .flatMap((summaries) => [...summaries].reverse())
      .find((value) => value.trim().length > 0);
    const progress: ProgressSnapshot = {
      ...(summary === undefined ? {} : { summary }),
      ...(active.progressMessage.trim().length === 0 ? {} : { message: active.progressMessage }),
      actions: Array.from(active.actions.values()).flat(),
      plan: active.plan,
    };
    active.stream.setProgress(progress);
  }

  private handleTurnCompleted(notification: TurnCompletedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined) return;
    if (active.turnId !== undefined && active.turnId !== notification.turn.id) return;
    active.completion.resolve(notification.turn);
  }

  private handleLoginCompleted(notification: AccountLoginCompletedNotification): void {
    this.#logger.info("Codex account login completed", {
      success: notification.success,
      error: notification.error,
    });
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const active = this.#activeByThread.get(request.params.threadId);
        const choice = await this.askApproval(
          active,
          `Codex wants to run:\n\n${request.params.command ?? "(unknown command)"}${
            request.params.reason === undefined || request.params.reason === null
              ? ""
              : `\n\nReason: ${request.params.reason}`
          }`,
        );
        const response: CommandExecutionRequestApprovalResponse = {
          decision:
            choice === "session" ? "acceptForSession" : choice === "once" ? "accept" : "decline",
        };
        await this.#rpc.reply(request.id, response);
        break;
      }
      case "item/fileChange/requestApproval": {
        const active = this.#activeByThread.get(request.params.threadId);
        const choice = await this.askApproval(
          active,
          `Codex wants permission to change files${
            request.params.reason === undefined || request.params.reason === null
              ? "."
              : `:\n\n${request.params.reason}`
          }`,
        );
        const response: FileChangeRequestApprovalResponse = {
          decision:
            choice === "session" ? "acceptForSession" : choice === "once" ? "accept" : "decline",
        };
        await this.#rpc.reply(request.id, response);
        break;
      }
      case "item/tool/requestUserInput": {
        const active = this.#activeByThread.get(request.params.threadId);
        const answers: Record<string, ToolRequestUserInputAnswer> = {};
        for (const question of request.params.questions) {
          if (active === undefined || question.options === null || question.options.length === 0) {
            answers[question.id] = { answers: [] };
            continue;
          }
          const options: ChoiceOption[] = question.options.map((option, index) => ({
            id: String(index),
            label: option.label,
            description: option.description,
          }));
          const answer = await active.responder.askChoice(question.question, options);
          const selected = question.options[Number(answer)];
          answers[question.id] = { answers: selected === undefined ? [] : [selected.label] };
        }
        const response: ToolRequestUserInputResponse = { answers };
        await this.#rpc.reply(request.id, response);
        break;
      }
      case "item/permissions/requestApproval": {
        const active = this.#activeByThread.get(request.params.threadId);
        const choice = await this.askApproval(
          active,
          request.params.reason ?? "Codex is requesting additional permissions.",
        );
        const response: PermissionsRequestApprovalResponse = {
          permissions:
            choice === "decline"
              ? {}
              : {
                  ...(request.params.permissions.network === null
                    ? {}
                    : { network: request.params.permissions.network }),
                  ...(request.params.permissions.fileSystem === null
                    ? {}
                    : { fileSystem: request.params.permissions.fileSystem }),
                },
          scope: choice === "session" ? "session" : "turn",
        };
        await this.#rpc.reply(request.id, response);
        break;
      }
      default:
        await this.#rpc.replyError(request.id, -32_601, `Unsupported request: ${request.method}`);
    }
  }

  private async askApproval(
    active: ActiveTurn | undefined,
    prompt: string,
  ): Promise<"once" | "session" | "decline"> {
    if (active === undefined) return "decline";
    const answer = await active.responder.askChoice(prompt, [
      { id: "once", label: "Allow once" },
      { id: "session", label: "Allow for session" },
      { id: "decline", label: "Deny" },
    ]);
    return answer === "once" || answer === "session" ? answer : "decline";
  }

  private finalTextFromTurn(turn: Turn): string {
    const messages = turn.items.filter((item) => item.type === "agentMessage");
    const finals = messages.filter((item) => item.phase === "final_answer");
    const selected = finals.length > 0 ? finals : messages.slice(-1);
    return selected
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n\n");
  }
}

function progressActions(item: ThreadItem): readonly ProgressAction[] {
  switch (item.type) {
    case "commandExecution":
      return [{ label: commandActionLabel(item) }];
    case "fileChange":
      return fileChangeActions(item.changes, item.status !== "inProgress");
    case "mcpToolCall":
      return [
        {
          label: `${item.status === "inProgress" ? "Calling" : "Called"} ${item.server}.${item.tool}${durationSuffix(item.durationMs)}`,
        },
      ];
    case "dynamicToolCall":
      return [
        {
          label: `${item.status === "inProgress" ? "Calling" : "Called"} ${item.namespace === null ? "" : `${item.namespace}.`}${item.tool}${durationSuffix(item.durationMs)}`,
        },
      ];
    case "collabAgentToolCall":
      return [
        {
          label: `${item.status === "inProgress" ? "Running" : "Ran"} ${collaborationLabel(item.tool)}`,
        },
      ];
    case "webSearch":
      return [{ label: `Searched  ${item.query || "the web"}` }];
    case "imageView":
      return [{ label: `Viewed    ${basename(item.path)}` }];
    case "imageGeneration":
      return [{ label: `${item.status === "inProgress" ? "Generating" : "Generated"} image` }];
    case "sleep":
      return [{ label: `Waited    ${formatDuration(item.durationMs)}` }];
    case "subAgentActivity":
      return [{ label: `${capitalize(item.kind)} agent ${item.agentPath}` }];
    case "enteredReviewMode":
      return [{ label: "Entered review mode" }];
    case "exitedReviewMode":
      return [{ label: "Exited review mode" }];
    default:
      return [];
  }
}

function fileChangeActions(
  changes: readonly FileUpdateChange[],
  completed: boolean,
): readonly ProgressAction[] {
  return changes.map((change) => {
    const verb =
      change.kind.type === "add"
        ? completed
          ? "Created"
          : "Creating"
        : change.kind.type === "delete"
          ? completed
            ? "Deleted"
            : "Deleting"
          : completed
            ? "Edited"
            : "Editing";
    const counts = diffCounts(change.diff);
    const diffSummary =
      change.kind.type === "delete" || counts.added + counts.removed === 0
        ? ""
        : `   +${counts.added} −${counts.removed}`;
    return { label: `${verb.padEnd(9)} ${basename(change.path)}${diffSummary}` };
  });
}

function commandActionLabel(item: Extract<ThreadItem, { type: "commandExecution" }>): string {
  const completed = item.status !== "inProgress";
  const action = item.commandActions.length === 1 ? item.commandActions[0] : undefined;
  let label: string;
  switch (action?.type) {
    case "read":
      label = `${completed ? "Read" : "Reading"}     ${action.name || basename(action.path)}`;
      break;
    case "listFiles":
      label = `${completed ? "Listed" : "Listing"}  files${action.path === null ? "" : ` in ${basename(action.path)}`}`;
      break;
    case "search":
      label = `${completed ? "Searched" : "Searching"} ${action.query ?? "files"}`;
      break;
    default:
      label = `${completed ? "Ran" : "Running"}      ${compactCommand(item.command)}`;
  }
  return `${label}${durationSuffix(item.durationMs)}`;
}

function diffCounts(diff: string): Readonly<{ added: number; removed: number }> {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function durationSuffix(durationMs: number | null): string {
  return durationMs === null ? "" : `   ${formatDuration(durationMs)}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 100) / 10}s`;
  return `${Math.round(durationMs / 60_000)}m`;
}

function compactCommand(command: string): string {
  const compact = command.replaceAll(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 119).trimEnd()}…`;
}

function collaborationLabel(
  tool: Extract<ThreadItem, { type: "collabAgentToolCall" }>["tool"],
): string {
  switch (tool) {
    case "spawnAgent":
      return "spawn agent";
    case "sendInput":
      return "send agent input";
    case "resumeAgent":
      return "resume agent";
    case "wait":
      return "wait for agents";
    case "closeAgent":
      return "close agent";
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}
