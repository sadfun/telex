import { basename, dirname, join } from "node:path";
import type { Personality } from "../generated/codex/Personality.js";
import type { ServerNotification } from "../generated/codex/ServerNotification.js";
import type { Config } from "../generated/codex/v2/Config.js";
import type { ConfigBatchWriteParams } from "../generated/codex/v2/ConfigBatchWriteParams.js";
import type { ConfigLayer } from "../generated/codex/v2/ConfigLayer.js";
import type { ConfigLayerSource } from "../generated/codex/v2/ConfigLayerSource.js";
import type { ConfigReadResponse } from "../generated/codex/v2/ConfigReadResponse.js";
import type { FsChangedNotification } from "../generated/codex/v2/FsChangedNotification.js";
import type { FsWatchResponse } from "../generated/codex/v2/FsWatchResponse.js";
import type { SkillMetadata } from "../generated/codex/v2/SkillMetadata.js";
import type { SkillsListResponse } from "../generated/codex/v2/SkillsListResponse.js";
import { BridgeError, errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { CodexConfigService } from "./config-service.js";
import type { CodexAppServer, CodexAppServerExit } from "./rpc.js";
import type { CodexService, EffectiveCodexSettings, ExplicitSkillInput } from "./service.js";
import { readSkillResource, type SkillResource } from "./skill-browser.js";

const CONFIG_WATCH_DEBOUNCE_MS = 300;

export type RuntimeState =
  | "starting"
  | "applying"
  | "restarting"
  | "ready"
  | "degraded"
  | "stopped";

export type RuntimeComponentState = "idle" | "ready" | "queued" | "error";

export interface RuntimeComponentStatus {
  readonly state: RuntimeComponentState;
  readonly message: string | null;
}

export interface CodexRuntimeStatus {
  readonly state: RuntimeState;
  readonly lastAppliedAt: string | null;
  readonly configPath: string | null;
  readonly restartRequired: boolean;
  readonly lastError: string | null;
  readonly config: RuntimeComponentStatus;
  readonly mcp: RuntimeComponentStatus;
  readonly skills: RuntimeComponentStatus;
}

export interface AvailableSkill {
  readonly name: string;
  readonly description: string;
}

export interface CodexRuntimeServiceOptions {
  readonly rpc: CodexAppServer;
  readonly codex: CodexService;
  readonly configService: Pick<CodexConfigService, "invalidateCapabilities">;
  readonly workspace: string;
  readonly logger: Logger;
}

interface ReconcileOptions {
  readonly hotReloadConfig: boolean;
  readonly reloadMcp: boolean;
  readonly forceSkills: boolean;
  readonly configResponse?: ConfigReadResponse;
  readonly configMessage: string;
  readonly freshServer: boolean;
}

interface ConfigWatch {
  readonly requestedPath: string;
  readonly path: string;
  readonly targets: ReadonlySet<string>;
}

interface ConfigTarget {
  readonly watchPath: string;
  readonly targetPath: string;
}

interface McpStartupRecord {
  readonly name: string;
  readonly threadId: string | null;
  readonly state: "starting" | "ready" | "failed" | "cancelled";
  readonly error: string | null;
}

/**
 * Keeps Telex's long-lived app-server synchronized through Codex's native
 * config, MCP, skill, and filesystem-watch protocol surface.
 */
export class CodexRuntimeService {
  readonly #rpc: CodexAppServer;
  readonly #codex: CodexService;
  readonly #configService: Pick<CodexConfigService, "invalidateCapabilities">;
  readonly #workspace: string;
  readonly #logger: Logger;
  readonly #skills = new Map<string, SkillMetadata>();
  readonly #watches = new Map<string, ConfigWatch>();
  readonly #mcpStartup = new Map<string, McpStartupRecord>();
  #settings: EffectiveCodexSettings = {};
  #serverModelProvider: string | null | undefined;
  #status: CodexRuntimeStatus = initialStatus();
  #operationTail: Promise<void> = Promise.resolve();
  #watchTimer: NodeJS.Timeout | undefined;
  #watchCounter = 0;
  #configFingerprint: string | undefined;
  #unsubscribeNotification: (() => void) | undefined;
  #unsubscribeExit: (() => void) | undefined;
  #stopped = true;

  public constructor(options: CodexRuntimeServiceOptions) {
    this.#rpc = options.rpc;
    this.#codex = options.codex;
    this.#configService = options.configService;
    this.#workspace = options.workspace;
    this.#logger = options.logger;
  }

  public async start(): Promise<CodexRuntimeStatus> {
    this.#stopped = false;
    this.#unsubscribeNotification ??= this.#rpc.onNotification((notification) => {
      this.handleNotification(notification);
    });
    this.#unsubscribeExit ??= this.#rpc.onExit((exit) => this.handleExit(exit));
    return await this.serialize(async () => {
      this.updateStatus({ state: "starting", lastError: null, restartRequired: false });
      return await this.reconcile({
        hotReloadConfig: false,
        reloadMcp: false,
        forceSkills: true,
        configMessage: "Effective config loaded by Codex.",
        freshServer: true,
      });
    });
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#watchTimer !== undefined) {
      clearTimeout(this.#watchTimer);
      this.#watchTimer = undefined;
    }
    await this.serialize(async () => {
      await this.clearWatches();
      this.updateStatus({ state: "stopped" });
    });
    this.#unsubscribeNotification?.();
    this.#unsubscribeNotification = undefined;
    this.#unsubscribeExit?.();
    this.#unsubscribeExit = undefined;
  }

  public status(): CodexRuntimeStatus {
    return {
      ...this.#status,
      config: { ...this.#status.config },
      mcp: { ...this.#status.mcp },
      skills: { ...this.#status.skills },
    };
  }

  public settings(): EffectiveCodexSettings {
    return this.#settings;
  }

  public skills(): readonly AvailableSkill[] {
    return [...this.#skills.values()]
      .map((skill) => ({ name: skill.name, description: skill.description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async browseSkill(name: string, path: string): Promise<SkillResource> {
    const skill = this.#skills.get(name);
    if (skill === undefined) {
      throw new BridgeError("This skill is not available to Codex.", "SKILL_NOT_FOUND");
    }
    return await readSkillResource(skill.path, path);
  }

  public skillInputs(text: string): readonly ExplicitSkillInput[] {
    if (this.#skills.size === 0) return [];
    const byName = new Map(
      [...this.#skills.values()].map((skill) => [skill.name.toLowerCase(), skill] as const),
    );
    const alternatives = [...this.#skills.keys()]
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|");
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])\\$(${alternatives})(?=$|[^A-Za-z0-9_:-])`, "gi");
    const inputs: ExplicitSkillInput[] = [];
    const included = new Set<string>();
    for (const match of text.matchAll(pattern)) {
      const mentioned = match[2];
      if (mentioned === undefined) continue;
      const skill = byName.get(mentioned.toLowerCase());
      if (skill === undefined || included.has(skill.name)) continue;
      included.add(skill.name);
      inputs.push({ type: "skill", name: skill.name, path: skill.path });
    }
    return inputs;
  }

  public async reload(): Promise<CodexRuntimeStatus> {
    return await this.serialize(async () => {
      this.updateStatus({ state: "applying", lastError: null });
      return await this.reconcile({
        hotReloadConfig: true,
        reloadMcp: true,
        forceSkills: true,
        configMessage: "Effective config hot-reloaded into loaded threads.",
        freshServer: false,
      });
    });
  }

  public async afterConfigWrite(): Promise<CodexRuntimeStatus> {
    return await this.serialize(async () => {
      this.updateStatus({ state: "applying", lastError: null });
      return await this.reconcile({
        hotReloadConfig: false,
        reloadMcp: true,
        forceSkills: true,
        configMessage: "Saved config hot-reloaded by Codex.",
        freshServer: false,
      });
    });
  }

  public async restart(): Promise<CodexRuntimeStatus> {
    return await this.serialize(async () => {
      this.updateStatus({ state: "restarting", lastError: null, restartRequired: false });
      try {
        await this.readConfig();
      } catch (error) {
        if (!isTransportUnavailable(error)) {
          const message = errorMessage(error);
          this.updateStatus({
            state: "degraded",
            lastError: message,
            restartRequired: false,
            config: { state: "error", message },
          });
          return this.status();
        }
      }

      this.#codex.pause();
      let resumeTurns = true;
      try {
        await this.#codex.waitForIdle();
        await this.#rpc.stop();
        resumeTurns = false;
        this.#watches.clear();
        this.#configFingerprint = undefined;
        await this.#rpc.start();
        resumeTurns = true;
        this.#mcpStartup.clear();
        this.#serverModelProvider = undefined;
        return await this.reconcile({
          hotReloadConfig: false,
          reloadMcp: false,
          forceSkills: true,
          configMessage: "Effective config loaded after app-server restart.",
          freshServer: true,
        });
      } catch (error) {
        const message = errorMessage(error);
        this.#logger.error("Could not restart the Codex app-server", error);
        this.updateStatus({
          state: "degraded",
          lastError: message,
          restartRequired: !resumeTurns,
          config: { state: "error", message },
        });
        return this.status();
      } finally {
        if (resumeTurns) this.#codex.resume();
      }
    });
  }

  private async reconcile(options: ReconcileOptions): Promise<CodexRuntimeStatus> {
    const errors: string[] = [];
    let restartRequired = options.freshServer ? false : this.#status.restartRequired;
    let response: ConfigReadResponse;
    try {
      response = options.configResponse ?? (await this.readConfig());
      if (options.hotReloadConfig) {
        const userLayer = findBaseUserLayer(response.layers);
        const params: ConfigBatchWriteParams = {
          edits: [],
          reloadUserConfig: true,
          ...(userLayer === undefined
            ? {}
            : { filePath: userLayer.name.file, expectedVersion: userLayer.version }),
        };
        await this.#rpc.request<unknown>({ method: "config/batchWrite", params });
        response = await this.readConfig();
      }
      const nextSettings = settingsFromConfig(response.config);
      const nextProvider = response.config.model_provider;
      if (options.freshServer || this.#serverModelProvider === undefined) {
        this.#serverModelProvider = nextProvider;
        restartRequired = false;
      } else {
        restartRequired = nextProvider !== this.#serverModelProvider;
      }
      this.#settings = nextSettings;
      this.#configService.invalidateCapabilities();
      this.#configFingerprint = fingerprint(response.layers);
      this.updateStatus({
        configPath: findBaseUserLayer(response.layers)?.name.file ?? null,
        config: {
          state: "ready",
          message: restartRequired
            ? "Config refreshed. The model provider will apply after an app-server restart."
            : options.configMessage,
        },
      });
      const watchError = await this.syncWatches(response.layers);
      if (watchError !== undefined) errors.push(watchError);
    } catch (error) {
      const message = errorMessage(error);
      errors.push(message);
      if (isTransportUnavailable(error)) restartRequired = true;
      this.updateStatus({ config: { state: "error", message } });
    }

    if (options.reloadMcp) {
      try {
        await this.#rpc.request<unknown>({ method: "config/mcpServer/reload", params: undefined });
        this.#mcpStartup.clear();
        this.updateStatus({
          mcp: {
            state: "queued",
            message: "Refresh queued for loaded threads; active on their next turn.",
          },
        });
      } catch (error) {
        const message = errorMessage(error);
        errors.push(message);
        if (isTransportUnavailable(error)) restartRequired = true;
        this.updateStatus({ mcp: { state: "error", message } });
      }
    } else {
      this.updateStatus({
        mcp: { state: "ready", message: "MCP servers loaded by the app-server." },
      });
    }

    if (options.forceSkills) {
      const skillError = await this.refreshSkills();
      if (skillError !== undefined) errors.push(skillError);
    }

    this.updateStatus({
      state: errors.length === 0 ? "ready" : "degraded",
      lastAppliedAt:
        errors.length === 0 && !restartRequired
          ? new Date().toISOString()
          : this.#status.lastAppliedAt,
      lastError: errors[0] ?? null,
      restartRequired,
    });
    return this.status();
  }

  private async refreshSkills(): Promise<string | undefined> {
    try {
      const response = await this.#rpc.request<SkillsListResponse>({
        method: "skills/list",
        params: { cwds: [this.#workspace], forceReload: true },
      });
      const entry =
        response.data.find((candidate) => candidate.cwd === this.#workspace) ?? response.data[0];
      this.#skills.clear();
      for (const skill of entry?.skills ?? []) {
        if (skill.enabled) this.#skills.set(skill.name, skill);
      }
      const errors = entry?.errors ?? [];
      if (errors.length > 0) {
        const message = errors.map((error) => `${error.path}: ${error.message}`).join("; ");
        this.updateStatus({ skills: { state: "error", message } });
        return message;
      }
      this.updateStatus({
        skills: {
          state: "ready",
          message: `${this.#skills.size} enabled ${this.#skills.size === 1 ? "skill" : "skills"} loaded.`,
        },
      });
      return undefined;
    } catch (error) {
      const message = errorMessage(error);
      this.updateStatus({ skills: { state: "error", message } });
      return message;
    }
  }

  private async readConfig(): Promise<ConfigReadResponse> {
    return await this.#rpc.request<ConfigReadResponse>({
      method: "config/read",
      params: { includeLayers: true, cwd: this.#workspace },
    });
  }

  private async syncWatches(layers: readonly ConfigLayer[] | null): Promise<string | undefined> {
    const wanted = new Map<string, Set<string>>();
    for (const layer of layers ?? []) {
      if (layer.disabledReason !== null) continue;
      const target = configLayerTarget(layer);
      if (target === undefined) continue;
      const targets = wanted.get(target.watchPath) ?? new Set<string>();
      targets.add(target.targetPath);
      wanted.set(target.watchPath, targets);
    }
    const errors: string[] = [];
    for (const [watchId, watch] of [...this.#watches]) {
      const targets = wanted.get(watch.requestedPath);
      if (targets !== undefined) {
        this.#watches.set(watchId, {
          ...watch,
          targets: canonicalWatchTargets(watch.requestedPath, watch.path, targets),
        });
        continue;
      }
      try {
        await this.#rpc.request<unknown>({ method: "fs/unwatch", params: { watchId } });
      } catch (error) {
        this.#logger.debug("Could not remove a stale Codex config watch", {
          watchId,
          error: errorMessage(error),
        });
      }
      this.#watches.delete(watchId);
    }
    const watchedPaths = new Set([...this.#watches.values()].map((watch) => watch.requestedPath));
    for (const [path, targets] of wanted) {
      if (watchedPaths.has(path)) continue;
      const watchId = `telex-config-${++this.#watchCounter}`;
      try {
        const response = await this.#rpc.request<FsWatchResponse>({
          method: "fs/watch",
          params: { watchId, path },
        });
        this.#watches.set(watchId, {
          requestedPath: path,
          path: response.path,
          targets: canonicalWatchTargets(path, response.path, targets),
        });
      } catch (error) {
        const message = `Could not watch ${path}: ${errorMessage(error)}`;
        errors.push(message);
        this.#logger.warn("Could not watch an active Codex config layer", { path, error });
      }
    }
    if (errors.length === 0) return undefined;
    const message = errors.join("; ");
    this.updateStatus({ config: { state: "error", message } });
    return message;
  }

  private async clearWatches(): Promise<void> {
    for (const watchId of this.#watches.keys()) {
      await this.#rpc
        .request<unknown>({ method: "fs/unwatch", params: { watchId } })
        .catch(() => undefined);
    }
    this.#watches.clear();
  }

  private handleNotification(notification: ServerNotification): void {
    switch (notification.method) {
      case "skills/changed":
        if (!this.#stopped) void this.refreshSkillsAfterChange();
        return;
      case "fs/changed":
        if (
          !this.#stopped &&
          isWatchedConfigChange(this.#watches.get(notification.params.watchId), notification.params)
        ) {
          this.scheduleExternalReload();
        }
        return;
      case "mcpServer/startupStatus/updated":
        this.handleMcpStatus(notification.params);
        return;
      default:
        return;
    }
  }

  private async refreshSkillsAfterChange(): Promise<void> {
    await this.serialize(async () => {
      const error = await this.refreshSkills();
      const remainingError = this.componentError();
      this.updateStatus({
        state: remainingError === undefined ? "ready" : "degraded",
        lastAppliedAt:
          remainingError === undefined && !this.#status.restartRequired
            ? new Date().toISOString()
            : this.#status.lastAppliedAt,
        lastError: error ?? remainingError ?? null,
      });
    });
  }

  private scheduleExternalReload(): void {
    if (this.#watchTimer !== undefined) clearTimeout(this.#watchTimer);
    this.#watchTimer = setTimeout(() => {
      this.#watchTimer = undefined;
      void this.reloadExternalConfig();
    }, CONFIG_WATCH_DEBOUNCE_MS);
    this.#watchTimer.unref();
  }

  private async reloadExternalConfig(): Promise<void> {
    await this.serialize(async () => {
      let response: ConfigReadResponse;
      try {
        response = await this.readConfig();
      } catch (error) {
        const message = errorMessage(error);
        this.updateStatus({
          state: "degraded",
          config: { state: "error", message },
          lastError: message,
        });
        return;
      }
      if (fingerprint(response.layers) === this.#configFingerprint) return;
      this.updateStatus({ state: "applying", lastError: null });
      await this.reconcile({
        hotReloadConfig: true,
        reloadMcp: true,
        forceSkills: true,
        configResponse: response,
        configMessage: "External config edit hot-reloaded into loaded threads.",
        freshServer: false,
      });
    });
  }

  private handleMcpStatus(
    status: Extract<
      ServerNotification,
      { readonly method: "mcpServer/startupStatus/updated" }
    >["params"],
  ): void {
    const key = `${status.threadId ?? "global"}\0${status.name}`;
    this.#mcpStartup.set(key, {
      name: status.name,
      threadId: status.threadId,
      state: status.status,
      error: status.error,
    });
    const records = [...this.#mcpStartup.values()];
    const failures = records.filter(
      (record) => record.state === "failed" || record.state === "cancelled",
    );
    if (failures.length > 0) {
      const message = failures
        .map(
          (record) =>
            `${record.name}${record.threadId === null ? "" : ` (${record.threadId})`}: ${record.error ?? record.state}`,
        )
        .join("; ");
      this.updateStatus({
        state: "degraded",
        mcp: { state: "error", message },
        lastError: message,
      });
      return;
    }
    const starting = records.filter((record) => record.state === "starting");
    if (starting.length > 0) {
      this.updateStatus({
        mcp: {
          state: "queued",
          message: `${starting.length} MCP ${starting.length === 1 ? "server is" : "servers are"} starting.`,
        },
      });
    } else {
      this.updateStatus({
        mcp: { state: "ready", message: "MCP servers are ready for loaded threads." },
      });
    }
    const remainingError = this.componentError();
    this.updateStatus({
      state: remainingError === undefined ? "ready" : "degraded",
      lastError: remainingError ?? null,
    });
  }

  private handleExit(exit: CodexAppServerExit): void {
    this.#watches.clear();
    if (exit.expected && this.#status.state === "restarting") return;
    this.updateStatus({
      state: "degraded",
      lastError: exit.error.message,
      restartRequired: true,
    });
  }

  private updateStatus(patch: Partial<CodexRuntimeStatus>): void {
    this.#status = { ...this.#status, ...patch };
  }

  private componentError(): string | undefined {
    return (
      [this.#status.config, this.#status.mcp, this.#status.skills].find(
        (component) => component.state === "error",
      )?.message ?? undefined
    );
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function initialStatus(): CodexRuntimeStatus {
  return {
    state: "starting",
    lastAppliedAt: null,
    configPath: null,
    restartRequired: false,
    lastError: null,
    config: { state: "idle", message: null },
    mcp: { state: "idle", message: null },
    skills: { state: "idle", message: null },
  };
}

function settingsFromConfig(config: Config): EffectiveCodexSettings {
  const personality = isPersonality(config.personality) ? config.personality : null;
  return {
    thread: {
      model: config.model,
      modelProvider: config.model_provider,
      serviceTier: config.service_tier,
      approvalPolicy: config.approval_policy,
      approvalsReviewer: config.approvals_reviewer,
      sandbox: config.sandbox_mode,
      baseInstructions: config.instructions,
      developerInstructions: config.developer_instructions,
      personality,
    },
    turn: {
      model: config.model,
      serviceTier: config.service_tier,
      approvalPolicy: config.approval_policy,
      approvalsReviewer: config.approvals_reviewer,
      effort: config.model_reasoning_effort,
      summary: config.model_reasoning_summary,
      personality,
    },
  };
}

function isPersonality(value: unknown): value is Personality {
  return value === "none" || value === "friendly" || value === "pragmatic";
}

type BaseUserLayer = ConfigLayer & {
  readonly name: Extract<ConfigLayerSource, { readonly type: "user" }>;
};

function findBaseUserLayer(layers: readonly ConfigLayer[] | null): BaseUserLayer | undefined {
  return layers?.find(
    (layer): layer is BaseUserLayer => layer.name.type === "user" && layer.name.profile === null,
  );
}

function configLayerTarget(layer: ConfigLayer): ConfigTarget | undefined {
  switch (layer.name.type) {
    case "system":
    case "user":
    case "legacyManagedConfigTomlFromFile":
      return { watchPath: dirname(layer.name.file), targetPath: layer.name.file };
    case "project":
      return {
        watchPath: layer.name.dotCodexFolder,
        targetPath: join(layer.name.dotCodexFolder, "config.toml"),
      };
    default:
      return undefined;
  }
}

function canonicalWatchTargets(
  requestedPath: string,
  canonicalPath: string,
  targets: ReadonlySet<string>,
): ReadonlySet<string> {
  const values = new Set<string>();
  for (const target of targets) {
    values.add(target);
    if (dirname(target) === requestedPath) values.add(join(canonicalPath, basename(target)));
  }
  return values;
}

function isWatchedConfigChange(
  watch: ConfigWatch | undefined,
  change: FsChangedNotification,
): boolean {
  return (
    watch !== undefined &&
    change.changedPaths.some((path) => path === watch.path || watch.targets.has(path))
  );
}

function isTransportUnavailable(error: unknown): boolean {
  return (
    error instanceof BridgeError &&
    (error.code === "CODEX_NOT_RUNNING" || error.code === "CODEX_EXITED")
  );
}

function fingerprint(layers: readonly ConfigLayer[] | null): string {
  return JSON.stringify(
    (layers ?? []).map((layer) => ({
      name: layer.name,
      version: layer.version,
      disabledReason: layer.disabledReason,
    })),
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
