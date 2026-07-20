import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  ChoiceOption,
  InboundAttachment,
  MessageResponder,
  OutboundAttachment,
  OutboundStream,
  ProgressAction,
  ProgressPlanStep,
  ProgressSnapshot,
  ProviderReference,
} from "../core/channel.js";
import type { ConversationStore } from "../core/conversation-store.js";
import type { ServerNotification } from "../generated/codex/ServerNotification.js";
import type { ServerRequest } from "../generated/codex/ServerRequest.js";
import type { JsonValue } from "../generated/codex/serde_json/JsonValue.js";
import type { AccountLoginCompletedNotification } from "../generated/codex/v2/AccountLoginCompletedNotification.js";
import type { AgentMessageDeltaNotification } from "../generated/codex/v2/AgentMessageDeltaNotification.js";
import type { CommandExecutionRequestApprovalResponse } from "../generated/codex/v2/CommandExecutionRequestApprovalResponse.js";
import type { DynamicToolCallParams } from "../generated/codex/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "../generated/codex/v2/DynamicToolCallResponse.js";
import type { DynamicToolSpec } from "../generated/codex/v2/DynamicToolSpec.js";
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
import type { ThreadStartParams } from "../generated/codex/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../generated/codex/v2/ThreadStartResponse.js";
import type { ToolRequestUserInputAnswer } from "../generated/codex/v2/ToolRequestUserInputAnswer.js";
import type { ToolRequestUserInputResponse } from "../generated/codex/v2/ToolRequestUserInputResponse.js";
import type { Turn } from "../generated/codex/v2/Turn.js";
import type { TurnCompletedNotification } from "../generated/codex/v2/TurnCompletedNotification.js";
import type { TurnInterruptResponse } from "../generated/codex/v2/TurnInterruptResponse.js";
import type { TurnPlanUpdatedNotification } from "../generated/codex/v2/TurnPlanUpdatedNotification.js";
import type { TurnStartedNotification } from "../generated/codex/v2/TurnStartedNotification.js";
import type { TurnStartParams } from "../generated/codex/v2/TurnStartParams.js";
import type { TurnStartResponse } from "../generated/codex/v2/TurnStartResponse.js";
import type { UserInput } from "../generated/codex/v2/UserInput.js";
import { type Deferred, deferred, KeyedSerialQueue, withTimeout } from "../shared/async.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { VoiceTranscriber } from "../transcription/service.js";
import { generatedFilePaths, resolveOutboundAttachments } from "./output-files.js";
import type { ApplicationContext, CodexAppServer } from "./rpc.js";

interface ActiveTurn {
  readonly conversationKey: string;
  readonly connector: string;
  readonly threadId: string;
  readonly responder: MessageResponder | undefined;
  readonly stream: OutboundStream;
  readonly invocation: CodexInvocationContext;
  readonly completion: Deferred<Turn>;
  readonly phases: Map<string, "commentary" | "final_answer" | null>;
  readonly actions: Map<string, readonly ProgressAction[]>;
  readonly reasoning: Map<string, readonly string[]>;
  readonly generatedPaths: string[];
  progressMessage: string;
  plan: readonly ProgressPlanStep[];
  finalText: string;
  turnId: string | undefined;
}

export interface CodexInvocationContext {
  readonly owner?: ProviderReference;
  readonly deliveryTarget?: ProviderReference;
  readonly additionalContext?: ApplicationContext;
  readonly automationId?: string;
}

export interface CodexDynamicToolContext extends CodexInvocationContext {
  readonly conversationKey: string;
  readonly connector: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
}

export interface CodexDynamicTool {
  readonly spec: DynamicToolSpec & { readonly type: "function" };
  execute(argumentsValue: JsonValue, context: CodexDynamicToolContext): Promise<unknown>;
}

export interface ScheduledTurnRequest {
  readonly conversationKey: string;
  readonly connector: string;
  readonly prompt: string;
  readonly thread:
    | { readonly mode: "new"; readonly developerInstructions?: string }
    | { readonly mode: "existing"; readonly threadId: string };
  readonly invocation: CodexInvocationContext;
  readonly model?: string;
  readonly reasoningEffort?: CodexTurnSettings["effort"];
  readonly outputSchema?: JsonValue;
}

export interface CodexTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  /** Unmodified final assistant text, before delivery-specific warnings. */
  readonly rawText: string;
  readonly text: string;
  readonly attachments: readonly OutboundAttachment[];
  readonly unavailableAttachments: readonly string[];
  dispose(): Promise<void>;
}

export type BackgroundLeaseDecision =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false; readonly reason: string; readonly retryAt: Date };

interface ExecuteTurnRequest {
  readonly conversationKey: string;
  readonly connector: string;
  readonly threadId: string;
  readonly input: readonly UserInput[];
  readonly turnSettings: CodexTurnSettings;
  readonly invocation: CodexInvocationContext;
  readonly responder?: MessageResponder;
  readonly stream: OutboundStream;
  readonly outputSchema?: JsonValue;
  readonly failIfInterrupted?: boolean;
}

export type LoginCompletedListener = (notification: AccountLoginCompletedNotification) => void;

export type CodexThreadSettings = Readonly<
  Pick<
    ThreadStartParams,
    | "model"
    | "modelProvider"
    | "serviceTier"
    | "approvalPolicy"
    | "approvalsReviewer"
    | "sandbox"
    | "config"
    | "baseInstructions"
    | "developerInstructions"
    | "personality"
  >
>;

export type CodexTurnSettings = Readonly<
  Pick<
    TurnStartParams,
    | "approvalPolicy"
    | "approvalsReviewer"
    | "sandboxPolicy"
    | "model"
    | "serviceTier"
    | "effort"
    | "summary"
    | "personality"
  >
>;

export interface EffectiveCodexSettings {
  readonly thread?: CodexThreadSettings;
  readonly turn?: CodexTurnSettings;
}

export type ExplicitSkillInput = Extract<UserInput, { readonly type: "skill" }>;
export type EffectiveCodexSettingsProvider = () =>
  | EffectiveCodexSettings
  | Promise<EffectiveCodexSettings>;
export type ExplicitSkillInputProvider = (
  text: string,
) => readonly ExplicitSkillInput[] | Promise<readonly ExplicitSkillInput[]>;

export interface CodexServiceProviders {
  readonly effectiveSettings?: EffectiveCodexSettingsProvider;
  readonly explicitSkillInputs?: ExplicitSkillInputProvider;
}

export class CodexService {
  static readonly #backgroundQuietPeriodMs = 30_000;
  readonly #queue = new KeyedSerialQueue();
  readonly #activeByThread = new Map<string, ActiveTurn>();
  readonly #activeByConversation = new Map<string, ActiveTurn>();
  readonly #dynamicTools = new Map<string, CodexDynamicTool>();
  readonly #foregroundWaiting = new Map<string, number>();
  readonly #lastForegroundAt = new Map<string, number>();
  readonly #loadedThreads = new Set<string>();
  readonly #loginListeners = new Set<LoginCompletedListener>();
  readonly #rpc: CodexAppServer;
  readonly #conversations: ConversationStore;
  readonly #workspace: string;
  readonly #generatedImagesDirectory: string;
  readonly #outboundDirectory: string;
  readonly #logger: Logger;
  readonly #voiceTranscriber: VoiceTranscriber | undefined;
  readonly #remoteClientContextEnabled: () => boolean;
  readonly #effectiveSettings: EffectiveCodexSettingsProvider;
  readonly #explicitSkillInputs: ExplicitSkillInputProvider;
  #pauseGate: Deferred<void> | undefined;
  #idleGate: Deferred<void> | undefined;
  #interruptingScheduledTurns = false;
  #runningJobs = 0;

  public constructor(
    rpc: CodexAppServer,
    conversations: ConversationStore,
    workspace: string,
    generatedImagesDirectory: string,
    outboundDirectory: string,
    logger: Logger,
    voiceTranscriber?: VoiceTranscriber,
    remoteClientContextEnabled: () => boolean = () => true,
    providers: CodexServiceProviders = {},
  ) {
    this.#rpc = rpc;
    this.#conversations = conversations;
    this.#workspace = workspace;
    this.#generatedImagesDirectory = generatedImagesDirectory;
    this.#outboundDirectory = outboundDirectory;
    this.#logger = logger;
    this.#voiceTranscriber = voiceTranscriber;
    this.#remoteClientContextEnabled = remoteClientContextEnabled;
    this.#effectiveSettings = providers.effectiveSettings ?? (() => ({}));
    this.#explicitSkillInputs = providers.explicitSkillInputs ?? (() => []);
    rpc.onNotification((notification) => this.handleNotification(notification));
    rpc.onExit((exit) => this.handleTransportExit(exit.error));
    rpc.setServerRequestHandler(async (request) => await this.handleServerRequest(request));
  }

  public pause(): void {
    this.#pauseGate ??= deferred<void>();
  }

  public async waitForIdle(): Promise<void> {
    if (this.#runningJobs === 0) return;
    this.#idleGate ??= deferred<void>();
    await this.#idleGate.promise;
  }

  public resume(): void {
    const gate = this.#pauseGate;
    if (gate === undefined) return;
    this.#pauseGate = undefined;
    gate.resolve();
  }

  public registerDynamicTool(tool: CodexDynamicTool): void {
    if (this.#dynamicTools.has(tool.spec.name)) {
      throw new Error(`Dynamic tool ${tool.spec.name} is already registered`);
    }
    this.#dynamicTools.set(tool.spec.name, tool);
  }

  public tryAcquireBackground(conversationKey: string): BackgroundLeaseDecision {
    const now = Date.now();
    const retryAt = new Date(now + CodexService.#backgroundQuietPeriodMs);
    if ((this.#foregroundWaiting.get(conversationKey) ?? 0) > 0) {
      return { acquired: false, reason: "A user message is waiting.", retryAt };
    }
    const lastForegroundAt = this.#lastForegroundAt.get(conversationKey);
    if (
      lastForegroundAt !== undefined &&
      now - lastForegroundAt < CodexService.#backgroundQuietPeriodMs
    ) {
      return {
        acquired: false,
        reason: "The conversation was used recently.",
        retryAt: new Date(lastForegroundAt + CodexService.#backgroundQuietPeriodMs),
      };
    }
    const lease = this.#queue.tryAcquire(conversationKey);
    if (lease === undefined) {
      return { acquired: false, reason: "The conversation is busy.", retryAt };
    }
    return { acquired: true, release: lease.release };
  }

  public async runTurn(
    conversationKey: string,
    connector: string,
    text: string,
    responder: MessageResponder,
    ephemeral = false,
    attachments: readonly InboundAttachment[] = [],
    invocation: CodexInvocationContext = {},
  ): Promise<void> {
    const stream = responder.createStream();
    const voiceAttachments = attachments.filter((attachment) => attachment.kind === "voice");
    const shouldTranscribe = voiceAttachments.length > 0 && this.#voiceTranscriber !== undefined;
    this.incrementForegroundWaiting(conversationKey);
    let dequeued = false;
    try {
      const startsQueued = this.#queue.isBusy(conversationKey);
      let preparedText: Promise<string> | undefined;
      if (shouldTranscribe) {
        await stream.start({ summary: "Transcribing…", actions: [], plan: [] });
        preparedText = this.transcribeVoiceMessages(text, voiceAttachments).then((prepared) => {
          stream.setProgress({ summary: "Thinking…", actions: [], plan: [] });
          return prepared;
        });
        void preparedText.catch(() => undefined);
      } else if (startsQueued) {
        await stream.start({ summary: "Queued behind earlier work…", actions: [], plan: [] });
      }

      await this.#queue.run(conversationKey, async () => {
        dequeued = true;
        this.decrementForegroundWaiting(conversationKey);
        await this.enterJob();
        let result: CodexTurnResult | undefined;
        try {
          if (!shouldTranscribe) {
            if (startsQueued) {
              stream.setProgress({ summary: "Thinking…", actions: [], plan: [] });
            } else {
              await stream.start();
            }
          }
          const prepared = preparedText === undefined ? text : await preparedText;
          const [settings, skillInputs] = await Promise.all([
            this.#effectiveSettings(),
            this.#explicitSkillInputs(prepared),
          ]);
          const threadId = await this.ensureThread(
            conversationKey,
            ephemeral,
            settings.thread ?? {},
          );
          result = await this.executeTurn({
            conversationKey,
            connector,
            threadId,
            input: [...createTurnInput(prepared, connector, attachments), ...skillInputs],
            turnSettings: settings.turn ?? {},
            invocation,
            responder,
            stream,
          });
          await stream.complete(
            result.text || (result.attachments.length === 0 ? "Done." : ""),
            result.attachments,
          );
        } catch (error) {
          this.#logger.error("Codex turn failed", error, { conversationKey });
          await stream.fail(errorMessage(error));
        } finally {
          await result?.dispose();
          this.#lastForegroundAt.set(conversationKey, Date.now());
          this.leaveJob();
        }
      });
    } finally {
      if (!dequeued) this.decrementForegroundWaiting(conversationKey);
    }
  }

  public async runScheduledTurn(request: ScheduledTurnRequest): Promise<CodexTurnResult> {
    await this.enterJob();
    try {
      const [settings, skillInputs] = await Promise.all([
        this.#effectiveSettings(),
        this.#explicitSkillInputs(request.prompt),
      ]);
      const threadId =
        request.thread.mode === "new"
          ? await this.startThread(
              {
                ...(settings.thread ?? {}),
                ...(request.model === undefined ? {} : { model: request.model }),
                ...(request.thread.developerInstructions === undefined
                  ? {}
                  : { developerInstructions: request.thread.developerInstructions }),
              },
              "automation",
            )
          : await this.resumeThreadStrict(request.thread.threadId, settings.thread ?? {});
      return await this.executeTurn({
        conversationKey: request.conversationKey,
        connector: request.connector,
        threadId,
        input: [...createTurnInput(request.prompt, request.connector, []), ...skillInputs],
        turnSettings: {
          ...(settings.turn ?? {}),
          approvalPolicy: "never",
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.reasoningEffort === undefined ? {} : { effort: request.reasoningEffort }),
        },
        invocation: request.invocation,
        stream: silentStream,
        failIfInterrupted: true,
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      });
    } finally {
      this.leaveJob();
    }
  }

  private async executeTurn(request: ExecuteTurnRequest): Promise<CodexTurnResult> {
    const stagingDirectory = join(this.#outboundDirectory, crypto.randomUUID());
    const active: ActiveTurn = {
      conversationKey: request.conversationKey,
      connector: request.connector,
      threadId: request.threadId,
      responder: request.responder,
      stream: request.stream,
      invocation: request.invocation,
      completion: deferred<Turn>(),
      phases: new Map(),
      actions: new Map(),
      reasoning: new Map(),
      generatedPaths: [],
      progressMessage: "",
      plan: [],
      finalText: "",
      turnId: undefined,
    };
    void active.completion.promise.catch(() => undefined);
    this.#activeByThread.set(request.threadId, active);
    this.#activeByConversation.set(request.conversationKey, active);

    try {
      const additionalContext = this.additionalContext(request.connector, request.invocation);
      const response = await this.#rpc.request<TurnStartResponse>({
        method: "turn/start",
        params: {
          ...request.turnSettings,
          threadId: request.threadId,
          clientUserMessageId: crypto.randomUUID(),
          input: [...request.input],
          ...(Object.keys(additionalContext).length === 0 ? {} : { additionalContext }),
          ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
        },
      });
      if (active.turnId !== undefined && active.turnId !== response.turn.id) {
        throw new BridgeError(
          "Codex returned inconsistent turn identifiers",
          "CODEX_TURN_MISMATCH",
        );
      }
      active.turnId = response.turn.id;
      if (this.#interruptingScheduledTurns && request.invocation.automationId !== undefined) {
        await this.#rpc.request<TurnInterruptResponse>({
          method: "turn/interrupt",
          params: { threadId: active.threadId, turnId: active.turnId },
        });
      }
      let turn: Turn;
      try {
        turn = await withTimeout(
          active.completion.promise,
          30 * 60 * 1_000,
          "Codex turn did not complete within 30 minutes",
        );
      } catch (error) {
        if (
          error instanceof BridgeError &&
          error.code === "TIMEOUT" &&
          active.turnId !== undefined
        ) {
          await this.#rpc
            .request<TurnInterruptResponse>({
              method: "turn/interrupt",
              params: { threadId: active.threadId, turnId: active.turnId },
            })
            .catch((interruptError: unknown) => {
              this.#logger.warn("Could not interrupt timed-out Codex turn", {
                error: errorMessage(interruptError),
              });
            });
        }
        throw error;
      }
      if (turn.status === "failed") {
        throw new BridgeError(turn.error?.message ?? "Codex turn failed", "CODEX_TURN_FAILED");
      }
      if (turn.status === "interrupted" && request.failIfInterrupted === true) {
        throw new BridgeError("Scheduled Codex turn was interrupted", "CODEX_TURN_INTERRUPTED");
      }

      const finalText = this.finalTextFromTurn(turn) || active.finalText;
      const resolution = await resolveOutboundAttachments(
        this.#workspace,
        this.#generatedImagesDirectory,
        stagingDirectory,
        finalText,
        [...active.generatedPaths, ...generatedFilePaths(turn.items)],
      );
      const responseText =
        turn.status === "interrupted" && finalText.length === 0
          ? "Stopped."
          : appendAttachmentWarning(finalText, resolution.unavailable);
      let disposed = false;
      return {
        threadId: request.threadId,
        turnId: turn.id,
        rawText: finalText,
        text: responseText,
        attachments: resolution.attachments,
        unavailableAttachments: resolution.unavailable,
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (this.#activeByThread.get(request.threadId) === active) {
        this.#activeByThread.delete(request.threadId);
      }
      if (this.#activeByConversation.get(request.conversationKey) === active) {
        this.#activeByConversation.delete(request.conversationKey);
      }
    }
  }

  private async transcribeVoiceMessages(
    text: string,
    attachments: readonly InboundAttachment[],
  ): Promise<string> {
    const transcriber = this.#voiceTranscriber;
    if (transcriber === undefined) return text;
    const transcripts: string[] = [];
    for (const attachment of attachments) {
      transcripts.push(await transcriber.transcribe(attachment.path));
    }
    const base = text.trim() === "[Voice message]" ? "" : text.trim();
    const blocks = transcripts.map((transcript, index) => {
      const heading =
        transcripts.length === 1
          ? "Voice message transcript:"
          : `Voice message transcript ${index + 1}:`;
      return `${heading}\n${transcript}`;
    });
    return [base, ...blocks].filter((part) => part.length > 0).join("\n\n");
  }

  public async resetConversation(conversationKey: string): Promise<void> {
    await this.interrupt(conversationKey);
    await this.#conversations.delete(conversationKey);
  }

  public async activateConversationThread(
    conversationKey: string,
    threadId: string,
  ): Promise<boolean> {
    if (
      this.#activeByConversation.has(conversationKey) ||
      (this.#foregroundWaiting.get(conversationKey) ?? 0) > 0
    ) {
      throw new BridgeError(
        "The conversation is busy. Stop or wait for the current turn first.",
        "CONVERSATION_BUSY",
      );
    }
    const lease = this.#queue.tryAcquire(conversationKey);
    if (lease === undefined) {
      throw new BridgeError(
        "The conversation is busy. Stop or wait for the current turn first.",
        "CONVERSATION_BUSY",
      );
    }
    try {
      const settings = await this.#effectiveSettings();
      const resumedThreadId = await this.resumeThreadStrict(threadId, settings.thread ?? {});
      return await this.#conversations.switchTo(conversationKey, resumedThreadId);
    } finally {
      lease.release();
    }
  }

  public async activatePreviousConversationThread(
    conversationKey: string,
  ): Promise<string | undefined> {
    const previous = this.#conversations.previous(conversationKey);
    if (previous === undefined) return undefined;
    await this.activateConversationThread(conversationKey, previous);
    return previous;
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

  public async interruptScheduledTurns(): Promise<void> {
    this.#interruptingScheduledTurns = true;
    const activeTurns = new Set(
      [...this.#activeByThread.values()].filter(
        (active) => active.invocation.automationId !== undefined && active.turnId !== undefined,
      ),
    );
    await Promise.allSettled(
      [...activeTurns].map(async (active) => {
        if (active.turnId === undefined) return;
        await this.#rpc.request<TurnInterruptResponse>({
          method: "turn/interrupt",
          params: { threadId: active.threadId, turnId: active.turnId },
        });
      }),
    );
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

  public onLoginCompleted(listener: LoginCompletedListener): void {
    this.#loginListeners.add(listener);
  }

  private async ensureThread(
    conversationKey: string,
    ephemeral: boolean,
    settings: CodexThreadSettings,
  ): Promise<string> {
    if (!ephemeral) {
      const stored = this.#conversations.get(conversationKey);
      if (stored !== undefined) {
        if (!this.#loadedThreads.has(stored)) {
          try {
            return await this.resumeThreadStrict(stored, settings);
          } catch (error) {
            if (
              error instanceof BridgeError &&
              (error.code === "CODEX_NOT_RUNNING" || error.code === "CODEX_EXITED")
            ) {
              throw error;
            }
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

    const threadId = await this.startThread(settings, "telex", ephemeral);
    if (!ephemeral) await this.#conversations.set(conversationKey, threadId);
    return threadId;
  }

  private async startThread(
    settings: CodexThreadSettings,
    threadSource: string,
    ephemeral = false,
  ): Promise<string> {
    const started = await this.#rpc.request<ThreadStartResponse>({
      method: "thread/start",
      params: {
        ...settings,
        cwd: this.#workspace,
        ephemeral,
        serviceName: "telex",
        threadSource,
        dynamicTools: [...this.#dynamicTools.values()].map((tool) => tool.spec),
      },
    });
    this.#loadedThreads.add(started.thread.id);
    return started.thread.id;
  }

  private async resumeThreadStrict(
    threadId: string,
    settings: CodexThreadSettings,
  ): Promise<string> {
    if (this.#loadedThreads.has(threadId)) return threadId;
    const resumed = await this.#rpc.request<ThreadResumeResponse>({
      method: "thread/resume",
      params: { ...settings, threadId, cwd: this.#workspace },
    });
    this.#loadedThreads.add(resumed.thread.id);
    return resumed.thread.id;
  }

  private additionalContext(
    connector: string,
    invocation: CodexInvocationContext,
  ): ApplicationContext {
    return {
      ...(this.#remoteClientContextEnabled() ? createRemoteClientContext(connector) : {}),
      ...(invocation.additionalContext ?? {}),
    };
  }

  private incrementForegroundWaiting(conversationKey: string): void {
    this.#foregroundWaiting.set(
      conversationKey,
      (this.#foregroundWaiting.get(conversationKey) ?? 0) + 1,
    );
  }

  private decrementForegroundWaiting(conversationKey: string): void {
    const waiting = (this.#foregroundWaiting.get(conversationKey) ?? 1) - 1;
    if (waiting <= 0) this.#foregroundWaiting.delete(conversationKey);
    else this.#foregroundWaiting.set(conversationKey, waiting);
  }

  private async enterJob(): Promise<void> {
    while (this.#pauseGate !== undefined) await this.#pauseGate.promise;
    this.#runningJobs += 1;
  }

  private leaveJob(): void {
    this.#runningJobs -= 1;
    if (this.#runningJobs !== 0) return;
    const gate = this.#idleGate;
    this.#idleGate = undefined;
    gate?.resolve();
  }

  private handleTransportExit(error: BridgeError): void {
    this.#loadedThreads.clear();
    for (const active of this.#activeByThread.values()) active.completion.reject(error);
  }

  private handleNotification(notification: ServerNotification): void {
    switch (notification.method) {
      case "turn/started":
        this.handleTurnStarted(notification.params);
        break;
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

  private handleTurnStarted(notification: TurnStartedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined) return;
    if (active.turnId !== undefined && active.turnId !== notification.turn.id) return;
    active.turnId = notification.turn.id;
  }

  private handleItemStarted(notification: ItemStartedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined || !matchesTurn(active, notification.turnId)) return;
    if (notification.item.type === "agentMessage") {
      active.phases.set(notification.item.id, notification.item.phase);
      if (notification.item.phase === "commentary") {
        active.progressMessage = notification.item.text;
      }
    }
    if (notification.item.type === "reasoning") {
      active.reasoning.set(notification.item.id, notification.item.summary);
    }
    if (
      notification.item.type === "imageGeneration" &&
      notification.item.savedPath !== undefined &&
      !active.generatedPaths.includes(notification.item.savedPath)
    ) {
      active.generatedPaths.push(notification.item.savedPath);
    }
    this.updateItemActions(active, notification.item);
  }

  private handleItemCompleted(notification: ItemCompletedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined || !matchesTurn(active, notification.turnId)) return;
    if (notification.item.type === "agentMessage") {
      active.phases.set(notification.item.id, notification.item.phase);
      if (notification.item.phase === "commentary") {
        active.progressMessage = notification.item.text;
      } else if (notification.item.text.length > 0) {
        active.finalText = notification.item.text;
      }
    }
    if (notification.item.type === "reasoning") {
      active.reasoning.set(notification.item.id, notification.item.summary);
    }
    if (
      notification.item.type === "imageGeneration" &&
      notification.item.savedPath !== undefined &&
      !active.generatedPaths.includes(notification.item.savedPath)
    ) {
      active.generatedPaths.push(notification.item.savedPath);
    }
    this.updateItemActions(active, notification.item);
  }

  private handleAgentDelta(notification: AgentMessageDeltaNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined || !matchesTurn(active, notification.turnId)) return;
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
    if (active === undefined || !matchesTurn(active, notification.turnId)) return;
    const summaries = [...(active.reasoning.get(notification.itemId) ?? [])];
    summaries[notification.summaryIndex] =
      `${summaries[notification.summaryIndex] ?? ""}${notification.delta}`;
    active.reasoning.set(notification.itemId, summaries);
    this.publishProgress(active);
  }

  private handleFileChangeUpdated(notification: FileChangePatchUpdatedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined || !matchesTurn(active, notification.turnId)) return;
    active.actions.set(notification.itemId, fileChangeActions(notification.changes, false));
    this.publishProgress(active);
  }

  private handlePlanUpdated(notification: TurnPlanUpdatedNotification): void {
    const active = this.#activeByThread.get(notification.threadId);
    if (active === undefined || !matchesTurn(active, notification.turnId)) return;
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
    if (active === undefined || !matchesTurn(active, notification.turn.id)) return;
    active.completion.resolve(notification.turn);
  }

  private handleLoginCompleted(notification: AccountLoginCompletedNotification): void {
    this.#logger.info("Codex account login completed", {
      success: notification.success,
      error: notification.error,
    });
    for (const listener of this.#loginListeners) {
      try {
        listener(notification);
      } catch (error) {
        this.#logger.error("Login completion listener failed", error);
      }
    }
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const candidate = this.#activeByThread.get(request.params.threadId);
        const active =
          candidate !== undefined && matchesTurn(candidate, request.params.turnId)
            ? candidate
            : undefined;
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
        const candidate = this.#activeByThread.get(request.params.threadId);
        const active =
          candidate !== undefined && matchesTurn(candidate, request.params.turnId)
            ? candidate
            : undefined;
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
        const candidate = this.#activeByThread.get(request.params.threadId);
        const active =
          candidate !== undefined && matchesTurn(candidate, request.params.turnId)
            ? candidate
            : undefined;
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
          const answer = await active.responder?.askChoice(question.question, options);
          const selected = question.options[Number(answer)];
          answers[question.id] = { answers: selected === undefined ? [] : [selected.label] };
        }
        const response: ToolRequestUserInputResponse = { answers };
        await this.#rpc.reply(request.id, response);
        break;
      }
      case "item/tool/call":
        await this.handleDynamicToolCall(request.params, request.id);
        break;
      case "item/permissions/requestApproval": {
        const candidate = this.#activeByThread.get(request.params.threadId);
        const active =
          candidate !== undefined && matchesTurn(candidate, request.params.turnId)
            ? candidate
            : undefined;
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

  private async handleDynamicToolCall(
    params: DynamicToolCallParams,
    requestId: ServerRequest["id"],
  ): Promise<void> {
    const active = this.#activeByThread.get(params.threadId);
    if (active === undefined || !matchesTurn(active, params.turnId) || params.namespace !== null) {
      await this.replyDynamicTool(requestId, false, "This tool call has no active Telex turn.");
      return;
    }
    const tool = this.#dynamicTools.get(params.tool);
    if (tool === undefined) {
      await this.replyDynamicTool(requestId, false, `Unknown dynamic tool: ${params.tool}`);
      return;
    }
    try {
      const result = await tool.execute(params.arguments, {
        ...active.invocation,
        conversationKey: active.conversationKey,
        connector: active.connector,
        threadId: active.threadId,
        turnId: params.turnId,
        callId: params.callId,
      });
      await this.replyDynamicTool(requestId, true, JSON.stringify(result));
    } catch (error) {
      this.#logger.warn("Dynamic tool call failed", {
        tool: params.tool,
        error: errorMessage(error),
      });
      await this.replyDynamicTool(requestId, false, errorMessage(error));
    }
  }

  private async replyDynamicTool(
    requestId: ServerRequest["id"],
    success: boolean,
    text: string,
  ): Promise<void> {
    const response: DynamicToolCallResponse = {
      success,
      contentItems: [{ type: "inputText", text }],
    };
    await this.#rpc.reply(requestId, response);
  }

  private async askApproval(
    active: ActiveTurn | undefined,
    prompt: string,
  ): Promise<"once" | "session" | "decline"> {
    if (active?.responder === undefined) return "decline";
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

const silentStream: OutboundStream = {
  start: async () => undefined,
  setProgress: () => undefined,
  appendFinal: () => undefined,
  complete: async () => undefined,
  fail: async () => undefined,
};

function matchesTurn(active: ActiveTurn, turnId: string): boolean {
  return active.turnId === turnId;
}

function appendAttachmentWarning(text: string, unavailable: readonly string[]): string {
  if (unavailable.length === 0) return text;
  const warning = `Could not attach ${unavailable.join(", ")}.`;
  return text.length === 0 ? warning : `${warning}\n\n${text}`;
}

export function createTurnInput(
  text: string,
  connector: string,
  attachments: readonly InboundAttachment[],
): UserInput[] {
  const connectorName = connectorDisplayName(connector);
  const files = attachments.filter((attachment) => attachment.kind !== "image");
  const fileContext = files
    .map((file) => `- ${file.description}: ${JSON.stringify(file.path)}`)
    .join("\n");
  const prompt =
    fileContext.length === 0
      ? text
      : `${text}\n\n${connectorName} files available in the local workspace:\n${fileContext}`;
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment): UserInput => ({ type: "localImage", path: attachment.path })),
  ];
}

export function createRemoteClientContext(connector: string): ApplicationContext {
  const connectorName = connectorDisplayName(connector);
  return {
    "telex.remote-client": {
      kind: "application",
      value: `This Codex session is operated through Telex, a remote messaging bridge. The user reads and replies through ${connectorName} and is not present at the machine where Codex and its commands run.

Host-local UI is not visible or accessible to the user:
- Do not open browsers, GUI applications, editors, file managers, or OAuth pages as a way of handing work to the user.
- Never ask the user to visit localhost, 127.0.0.1, a file:// URL, or another host-local address. Those addresses refer to the Codex host, not the user's device.
- You may run and access local services yourself for development and testing. Only present a URL to the user when it is reachable from their device.
- For authentication, prefer a device-code flow or a publicly reachable HTTPS flow and send the URL and code through chat. If only a local callback exists, explain the constraint and offer a remote-safe alternative such as a device flow, tunnel, or SSH port forwarding.
- Do not assume the user can see the host screen, clipboard, notifications, or spawned windows.
- Explicitly link files intended for the user in the final response so Telex can deliver them.

All normal Codex filesystem, shell, network, approval, and project behavior remains unchanged. Telex changes only how the user communicates with Codex.`,
    },
  };
}

function connectorDisplayName(connector: string): string {
  const words = connector
    .trim()
    .split(/[-_\s]+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "a remote messaging connector";
  return words
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
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
