import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScheduledRunsEngine } from "../../automations/engine.js";
import { AutomationStore } from "../../automations/store.js";
import { CodexConfigService } from "../../codex/config-service.js";
import { CodexAppServer } from "../../codex/rpc.js";
import { CodexRuntimeService } from "../../codex/runtime-service.js";
import { CodexService } from "../../codex/service.js";
import { CodexToolchainManager, readPinnedCodexVersion } from "../../codex/toolchain.js";
import type { LoginAccountResponse } from "../../generated/codex/v2/LoginAccountResponse.js";
import { atomicWriteFile, ensureDirectory } from "../../shared/fs.js";
import { Logger, type LogLevel } from "../../shared/logger.js";
import { readTelexVersion } from "../../shared/version.js";
import { ChatGptVoiceTranscriber, type VoiceTranscriber } from "../../transcription/service.js";
import { CurlImpersonateTransport } from "../../transcription/transport.js";
import { CodexBridge } from "../bridge.js";
import type { MessagingChannel } from "../channel.js";
import { ConversationStore } from "../conversation-store.js";
import { ProtocolE2eChannel } from "./protocol-channel.js";
import { attachCodexE2eTrace, E2eTrace } from "./trace.js";

export interface CodexE2eToken {
  readonly accessToken: string;
  readonly accountId: string;
  readonly planType?: string | null;
}

export const E2E_MODEL = "gpt-5.6-luna";
export const E2E_REASONING_EFFORT = "medium";

export interface CodexE2eTokenRequest {
  readonly reason: "initial" | "unauthorized";
  readonly previousAccountId?: string | null;
}

export type CodexE2eTokenProvider = (request: CodexE2eTokenRequest) => Promise<CodexE2eToken>;

export interface E2eChannelContext {
  readonly root: string;
  readonly workspace: string;
  readonly logger: Logger;
}

export interface LaunchE2eTelexOptions {
  readonly requestToken: CodexE2eTokenProvider;
  readonly trace?: E2eTrace;
  readonly projectRoot?: string;
  readonly codexBinaryPath?: string;
  readonly logLevel?: LogLevel;
  readonly now?: () => Date;
  readonly createChannels?: (
    context: E2eChannelContext,
  ) => MessagingChannel | readonly MessagingChannel[];
}

class TokenBroker {
  readonly #request: CodexE2eTokenProvider;
  #token: CodexE2eToken | undefined;

  public constructor(request: CodexE2eTokenProvider) {
    this.#request = request;
  }

  public async refresh(request: CodexE2eTokenRequest): Promise<CodexE2eToken> {
    const token = await this.#request(request);
    if (token.accessToken.length === 0 || token.accountId.length === 0) {
      throw new Error("Codex returned an incomplete E2E token");
    }
    this.#token = token;
    return token;
  }

  public async current(): Promise<CodexE2eToken> {
    return this.#token ?? (await this.refresh({ reason: "initial" }));
  }
}

export class E2eTelexInstance {
  public readonly root: string;
  public readonly workspace: string;
  public readonly channels: readonly MessagingChannel[];
  public readonly protocol: ProtocolE2eChannel | undefined;
  public readonly codex: CodexService;
  public readonly scheduler: ScheduledRunsEngine;
  public readonly trace: E2eTrace;
  readonly #runtime: CodexRuntimeService;
  readonly #rpc: CodexAppServer;
  #stopped = false;

  public constructor(options: {
    root: string;
    workspace: string;
    channels: readonly MessagingChannel[];
    codex: CodexService;
    scheduler: ScheduledRunsEngine;
    trace: E2eTrace;
    runtime: CodexRuntimeService;
    rpc: CodexAppServer;
  }) {
    this.root = options.root;
    this.workspace = options.workspace;
    this.channels = options.channels;
    this.protocol = options.channels.find(
      (channel): channel is ProtocolE2eChannel => channel instanceof ProtocolE2eChannel,
    );
    this.codex = options.codex;
    this.scheduler = options.scheduler;
    this.trace = options.trace;
    this.#runtime = options.runtime;
    this.#rpc = options.rpc;
  }

  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      await this.scheduler.stop();
      for (const channel of this.channels.toReversed()) await channel.stop();
      await this.#runtime.stop();
      await this.#rpc.stop();
    } finally {
      if (this.root.startsWith(join(tmpdir(), "telex-e2e-"))) {
        await rm(this.root, { recursive: true, force: true });
      }
    }
  }
}

export async function launchE2eTelex(options: LaunchE2eTelexOptions): Promise<E2eTelexInstance> {
  const trace = options.trace ?? new E2eTrace();
  const root = await mkdtemp(join(tmpdir(), "telex-e2e-"));
  const projectRoot = options.projectRoot ?? fileURLToPath(new URL("../../../", import.meta.url));
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const toolchains = join(root, "toolchains");
  const outbound = join(root, "outbound");
  const logger = new Logger(options.logLevel ?? "info", { service: "telex-e2e" });
  let instance: E2eTelexInstance | undefined;
  let rpc: CodexAppServer | undefined;
  try {
    await trace.startupSpan("Prepare isolated directories and config", async () => {
      await Promise.all([
        ensureDirectory(workspace),
        ensureDirectory(codexHome),
        ensureDirectory(outbound),
      ]);
      await atomicWriteFile(
        join(codexHome, "config.toml"),
        `model = "${E2E_MODEL}"\nmodel_reasoning_effort = "${E2E_REASONING_EFFORT}"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nweb_search = "live"\ncli_auth_credentials_store = "file"\nproject_root_markers = []\n`,
      );
    });
    const binaryPath =
      options.codexBinaryPath ??
      (await trace.startupSpan(
        "Install pinned Codex toolchain",
        async () =>
          await new CodexToolchainManager(
            toolchains,
            logger.child({ component: "toolchain" }),
          ).ensureVersion(await readPinnedCodexVersion(projectRoot)),
      ));
    rpc = new CodexAppServer(
      binaryPath,
      workspace,
      codexHome,
      await readTelexVersion(projectRoot),
      logger.child({ component: "codex-rpc" }),
    );
    const activeRpc = rpc;
    await trace.startupSpan("Start Codex app-server", async () => await activeRpc.start());
    attachCodexE2eTrace(activeRpc, trace);

    const conversations = new ConversationStore(
      join(root, "conversations.json"),
      logger.child({ component: "conversation-store" }),
    );
    const automations = new AutomationStore(
      join(root, "automations.json"),
      logger.child({ component: "automation-store" }),
    );
    await trace.startupSpan("Load Telex stores", async () => {
      await Promise.all([conversations.load(), automations.load()]);
    });
    const broker = new TokenBroker(options.requestToken);
    const initialToken = await broker.current();
    const transport = new CurlImpersonateTransport(
      toolchains,
      logger.child({ component: "transcription-transport" }),
    );
    const liveTranscriber = new ChatGptVoiceTranscriber(
      codexHome,
      transport,
      async () => {
        await broker.refresh({ reason: "unauthorized" });
      },
      async () => {
        const token = await broker.current();
        return { accessToken: token.accessToken, accountId: token.accountId };
      },
    );
    const transcriber: VoiceTranscriber = {
      transcribe: async (path) =>
        await trace.span("Voice transcription", async () => await liveTranscriber.transcribe(path)),
    };
    let liveRuntime: CodexRuntimeService | undefined;
    const codex = new CodexService(
      activeRpc,
      conversations,
      workspace,
      join(codexHome, "generated_images"),
      outbound,
      logger.child({ component: "codex" }),
      transcriber,
      () => false,
      {
        effectiveSettings: () => liveRuntime?.settings() ?? {},
        explicitSkillInputs: (text) => liveRuntime?.skillInputs(text) ?? [],
        externalAuthTokens: async (request) => {
          const token = await broker.refresh({
            reason: "unauthorized",
            ...(request.previousAccountId === undefined
              ? {}
              : { previousAccountId: request.previousAccountId }),
          });
          return {
            accessToken: token.accessToken,
            chatgptAccountId: token.accountId,
            chatgptPlanType: token.planType ?? null,
          };
        },
        ...(options.now === undefined
          ? {}
          : { now: () => options.now?.().getTime() ?? Date.now() }),
      },
    );
    const login = await trace.startupSpan(
      "Authenticate Codex account",
      async () =>
        await activeRpc.request<LoginAccountResponse>({
          method: "account/login/start",
          params: {
            type: "chatgptAuthTokens",
            accessToken: initialToken.accessToken,
            chatgptAccountId: initialToken.accountId,
            chatgptPlanType: initialToken.planType ?? null,
          },
        }),
    );
    if (login.type !== "chatgptAuthTokens") throw new Error("Codex rejected external E2E auth");

    const configService = new CodexConfigService(activeRpc, workspace);
    const config = await trace.startupSpan(
      "Read config and model capabilities",
      async () => await configService.read(),
    );
    const model = config.capabilities.models.find((candidate) => candidate.model === E2E_MODEL);
    if (model === undefined) throw new Error(`E2E model is unavailable: ${E2E_MODEL}`);
    if (
      !model.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === E2E_REASONING_EFFORT,
      )
    ) {
      throw new Error(`E2E reasoning effort is unavailable: ${E2E_REASONING_EFFORT}`);
    }
    const runtime = new CodexRuntimeService({
      rpc: activeRpc,
      codex,
      configService,
      workspace,
      logger: logger.child({ component: "runtime" }),
    });
    liveRuntime = runtime;
    await trace.startupSpan("Start Codex runtime", async () => await runtime.start());
    const context = { root, workspace, logger };
    const created = options.createChannels?.(context) ?? new ProtocolE2eChannel(trace);
    const channels = Array.isArray(created) ? created : [created];
    const scheduler = new ScheduledRunsEngine({
      store: automations,
      codex,
      channels,
      workspace,
      logger: logger.child({ component: "scheduler" }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const bridge = new CodexBridge(
      codex,
      undefined,
      logger.child({ component: "bridge" }),
      {
        canInstall: false,
        run: async () => ({ status: "current", version: await readTelexVersion(projectRoot) }),
        onInstalled: () => undefined,
      },
      runtime,
      scheduler,
    );
    await trace.startupSpan("Start messaging channels", async () => {
      for (const channel of channels) await channel.start(bridge.handleMessage);
    });
    await trace.startupSpan("Start scheduler", async () => await scheduler.start());
    instance = new E2eTelexInstance({
      root,
      workspace,
      channels,
      codex,
      scheduler,
      trace,
      runtime,
      rpc: activeRpc,
    });
    return instance;
  } catch (error) {
    await instance?.stop().catch(() => undefined);
    await rpc?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
