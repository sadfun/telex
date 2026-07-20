import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AutomationStore, ScheduledRunsEngine } from "./automations/index.js";
import { TelegramChannel } from "./channels/telegram/channel.js";
import { CodexConfigService } from "./codex/config-service.js";
import { CodexAppServer } from "./codex/rpc.js";
import { CodexRuntimeService } from "./codex/runtime-service.js";
import { CodexService } from "./codex/service.js";
import { CodexToolchainManager, readPinnedCodexVersion } from "./codex/toolchain.js";
import { loadAppConfig } from "./config/env.js";
import { CodexBridge } from "./core/bridge.js";
import { ConversationStore } from "./core/conversation-store.js";
import { TelexSettingsStore } from "./core/settings-store.js";
import { ensureCloudflared } from "./miniapp/cloudflared.js";
import { MiniAppServer } from "./miniapp/server.js";
import { QuickTunnel } from "./miniapp/tunnel.js";
import { deferred } from "./shared/async.js";
import { errorMessage } from "./shared/errors.js";
import { atomicWriteFile, ensureDirectory } from "./shared/fs.js";
import { Logger } from "./shared/logger.js";
import { readTelexVersion } from "./shared/version.js";
import { ChatGptVoiceTranscriber } from "./transcription/service.js";
import { CurlImpersonateTransport } from "./transcription/transport.js";
import { monitorUpdates } from "./update/monitor.js";
import { ReleaseUpdater } from "./update/release.js";

const defaultConfig = `# Managed by Telex. You can edit this file or use the Telegram Mini App.
approval_policy = "on-request"
sandbox_mode = "workspace-write"
web_search = "live"
cli_auth_credentials_store = "file"
project_root_markers = []
`;

interface Stoppable {
  stop(): Promise<void>;
}

export interface TelexRunResult {
  readonly reason: "shutdown" | "updated";
  readonly version?: string;
}

export async function runTelex(): Promise<TelexRunResult> {
  const config = loadAppConfig();
  const logger = new Logger(config.logLevel, { service: "telex" });
  const shutdown = shutdownSignal(logger);
  const updateAbort = new AbortController();
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const bridgeVersion = await readTelexVersion(projectRoot);
  const codexHome = join(config.dataDirectory, "codex-home");
  const outboundDirectory = join(config.dataDirectory, "outbound");
  const toolchainsDirectory = join(config.dataDirectory, "toolchains");
  const statePath = join(config.dataDirectory, "conversations.json");
  const settingsPath = join(config.dataDirectory, "settings.json");
  const automationsPath = join(config.dataDirectory, "automations.json");
  const resources: Stoppable[] = [];
  const manuallyInstalledUpdate = deferred<string>();
  let updateMonitor: Promise<string | undefined> | undefined;

  try {
    await Promise.all([
      ensureDirectory(config.dataDirectory),
      ensureDirectory(config.workspace),
      ensureDirectory(codexHome),
      ensureDirectory(outboundDirectory),
    ]);
    await ensureDefaultCodexConfig(join(codexHome, "config.toml"));

    const pinnedVersion = await readPinnedCodexVersion(projectRoot);
    const toolchains = new CodexToolchainManager(
      toolchainsDirectory,
      logger.child({ component: "toolchain" }),
    );
    const binaryPath = await toolchains.ensureVersion(pinnedVersion);
    checkForCodexUpdate(
      toolchains,
      pinnedVersion,
      config.checkCodexUpdates,
      config.installDirectory === undefined
        ? "npm run codex:update"
        : "install a Telex release that includes the compatible Codex protocol",
      logger,
    );

    const rpc = new CodexAppServer(
      binaryPath,
      config.workspace,
      codexHome,
      bridgeVersion,
      logger.child({ component: "codex-rpc" }),
    );
    resources.push(rpc);
    await rpc.start();

    const conversations = new ConversationStore(
      statePath,
      logger.child({ component: "conversation-store" }),
    );
    const settings = new TelexSettingsStore(
      settingsPath,
      logger.child({ component: "settings-store" }),
    );
    const automations = new AutomationStore(
      automationsPath,
      logger.child({ component: "automation-store" }),
    );
    await Promise.all([conversations.load(), settings.load(), automations.load()]);
    const transcriptionTransport = new CurlImpersonateTransport(
      toolchainsDirectory,
      logger.child({ component: "transcription-transport" }),
    );
    const voiceTranscriber = new ChatGptVoiceTranscriber(
      codexHome,
      transcriptionTransport,
      async () => {
        await rpc.request<unknown>({
          method: "account/read",
          params: { refreshToken: true },
        });
      },
    );
    let liveRuntime: CodexRuntimeService | undefined;
    const codex = new CodexService(
      rpc,
      conversations,
      config.workspace,
      join(codexHome, "generated_images"),
      outboundDirectory,
      logger.child({ component: "codex" }),
      voiceTranscriber,
      () => settings.read().remoteClientContext,
      {
        effectiveSettings: () => liveRuntime?.settings() ?? {},
        explicitSkillInputs: (text) => liveRuntime?.skillInputs(text) ?? [],
      },
    );
    const configService = new CodexConfigService(rpc, config.workspace);
    const runtime = new CodexRuntimeService({
      rpc,
      codex,
      configService,
      workspace: config.workspace,
      logger: logger.child({ component: "codex-runtime" }),
    });
    liveRuntime = runtime;
    resources.push(runtime);
    await runtime.start();

    const miniApp = new MiniAppServer({
      host: config.host,
      port: config.port,
      botToken: config.telegramToken,
      allowedUserIds: config.allowedUserIds,
      configService,
      runtime,
      settings,
      logger: logger.child({ component: "miniapp" }),
    });
    resources.push(miniApp);
    await miniApp.start();

    let publicUrl = config.publicUrl;
    if (publicUrl === undefined && config.tunnelMode === "auto") {
      try {
        const binary = await ensureCloudflared(
          toolchainsDirectory,
          logger.child({ component: "tunnel" }),
        );
        const tunnel = new QuickTunnel({
          host: config.host,
          port: config.port,
          binary,
          logger: logger.child({ component: "tunnel" }),
        });
        publicUrl = await tunnel.start();
        resources.push(tunnel);
        logger.info("The Mini App is exposed through a TryCloudflare quick tunnel", {
          url: publicUrl,
        });
      } catch (error) {
        logger.warn(
          "No PUBLIC_URL and no quick tunnel; the settings Mini App is disabled. Set PUBLIC_URL, or set TELEX_TUNNEL=auto with network access to GitHub releases.",
          { error: errorMessage(error) },
        );
      }
    }

    const updater = new ReleaseUpdater({
      repository: config.updateRepository,
      currentVersion: bridgeVersion,
      ...(config.installDirectory === undefined
        ? {}
        : { installDirectory: config.installDirectory }),
      logger: logger.child({ component: "updater" }),
    });
    const telegram = new TelegramChannel(
      config.telegramToken,
      config.telegramApiBase,
      config.allowedUserIds,
      config.telegramPollTimeout,
      join(config.workspace, ".telex", "attachments"),
      logger.child({ component: "telegram" }),
    );
    const scheduledRuns = new ScheduledRunsEngine({
      store: automations,
      codex,
      channels: [telegram],
      workspace: config.workspace,
      logger: logger.child({ component: "scheduled-runs" }),
    });
    const bridge = new CodexBridge(
      codex,
      publicUrl,
      logger.child({ component: "bridge" }),
      {
        canInstall: config.installDirectory !== undefined,
        run: async () => {
          const status = await updater.check("latest", updateAbort.signal);
          if (!status.updateAvailable) {
            return { status: "current", version: status.currentVersion };
          }
          const installed = await updater.install(status.release, updateAbort.signal);
          return {
            status: "installed",
            previousVersion: installed.previousVersion,
            version: installed.version,
          };
        },
        onInstalled: manuallyInstalledUpdate.resolve,
      },
      runtime,
      scheduledRuns,
    );
    resources.push(telegram);
    await telegram.start(bridge.handleMessage);
    resources.push(scheduledRuns);
    await scheduledRuns.start();

    logger.info("Telex is ready", {
      version: bridgeVersion,
      codexVersion: pinnedVersion,
      workspace: config.workspace,
      miniApp: `${config.host}:${config.port}`,
    });

    if (config.updateMode !== "off") {
      updateMonitor = monitorUpdates({
        updater,
        mode: config.updateMode,
        intervalMs: config.updateIntervalMs,
        canInstall: config.installDirectory !== undefined,
        logger: logger.child({ component: "updater" }),
        signal: updateAbort.signal,
      });
    }
    const automaticUpdate =
      updateMonitor?.then((version): Promise<string> | string =>
        version === undefined ? new Promise<string>(() => undefined) : version,
      ) ?? new Promise<string>(() => undefined);
    const update = Promise.race([automaticUpdate, manuallyInstalledUpdate.promise]);
    const completed = await Promise.race([
      shutdown.promise.then(() => ({ reason: "shutdown" }) as const),
      update.then((version) => ({ reason: "updated", version }) as const),
    ]);
    if (completed.reason === "updated") {
      logger.info("Restarting to run the installed Telex release", { version: completed.version });
    }
    return completed;
  } catch (error) {
    logger.error("Telex failed", error);
    throw error;
  } finally {
    shutdown.dispose();
    updateAbort.abort();
    await updateMonitor;
    await stopAll(resources, logger);
  }
}

async function ensureDefaultCodexConfig(path: string): Promise<void> {
  try {
    await access(path);
    const contents = await readFile(path, "utf8");
    const hasCredentialStore = /^\s*cli_auth_credentials_store\s*=/mu.test(contents);
    const withoutProjectRootMarkers = contents.replace(
      /^\s*project_root_markers\s*=.*(?:\r?\n|$)/gmu,
      "",
    );
    const firstTable = withoutProjectRootMarkers.search(/^\s*\[/mu);
    const root =
      firstTable < 0 ? withoutProjectRootMarkers : withoutProjectRootMarkers.slice(0, firstTable);
    const tables = firstTable < 0 ? "" : withoutProjectRootMarkers.slice(firstTable);
    const credentialStore = hasCredentialStore ? "" : '\ncli_auth_credentials_store = "file"';
    const isolated = `${root.trimEnd()}${credentialStore}\nproject_root_markers = []\n${tables.length === 0 ? "" : `\n${tables.trimStart()}`}`;
    if (isolated !== contents) {
      await atomicWriteFile(path, isolated);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWriteFile(path, defaultConfig);
  }
}

function checkForCodexUpdate(
  toolchains: CodexToolchainManager,
  pinnedVersion: string,
  enabled: boolean,
  updateAction: string,
  logger: Logger,
): void {
  if (!enabled) return;
  void toolchains
    .latestVersion()
    .then((latestVersion) => {
      if (latestVersion === pinnedVersion) {
        logger.debug("Codex CLI is current", { version: pinnedVersion });
      } else {
        logger.info("A newer Codex CLI is available", {
          pinnedVersion,
          latestVersion,
          updateAction,
        });
      }
    })
    .catch((error: unknown) => {
      logger.warn("Could not check for a Codex CLI update", { error: errorMessage(error) });
    });
}

function shutdownSignal(logger: Logger): {
  readonly promise: Promise<void>;
  readonly dispose: () => void;
} {
  let onInterrupt: () => void;
  let onTerminate: () => void;
  const dispose = (): void => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  };
  const promise = new Promise<void>((resolvePromise) => {
    const handle = (signal: NodeJS.Signals): void => {
      dispose();
      logger.info("Shutting down", { signal });
      resolvePromise();
    };
    onInterrupt = (): void => handle("SIGINT");
    onTerminate = (): void => handle("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
  return { promise, dispose };
}

async function stopAll(resources: readonly Stoppable[], logger: Logger): Promise<void> {
  for (const resource of resources.toReversed()) {
    try {
      await resource.stop();
    } catch (error) {
      logger.error("Shutdown step failed", error);
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  void runTelex()
    .then((result) => {
      if (result.reason === "updated") process.exitCode = 75;
    })
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}
