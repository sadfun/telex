import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { cp, lstat, mkdir, open, readFile, realpath, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { Api } from "grammy";
import { z } from "zod";
import { storedStateSchema as automationSchema } from "../automations/store.js";
import { loadAppConfig } from "../config/env.js";
import { storedStateSchema as conversationSchema } from "../core/conversation-store.js";
import { storedSettingsSchema as settingsSchema } from "../core/settings-store.js";
import { atomicWriteFile, atomicWriteJson } from "../shared/fs.js";
import { Logger } from "../shared/logger.js";
import { bindMount, Docker, ensureDocker, wirebotImage } from "./docker.js";

type Config = ReturnType<typeof loadAppConfig>;
const ownerLabel = "io.github.sadfun.telex-migration";
const stateSchema = z.object({
  version: z.literal(1),
  status: z.enum(["prepared", "active"]),
  name: z.string().regex(/^telex-wirebot-[a-f0-9]{12}$/),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  dockerCommand: z.array(z.string()).min(1),
  runArguments: z.array(z.string()),
  dataDirectory: z.string().min(1),
  updating: z.boolean(),
  expectAuthentication: z.boolean(),
  notifiedUserIds: z.array(z.number().int().positive()),
});
type MigrationState = z.infer<typeof stateSchema>;

export const migrationMessage =
  'Telex just got a big update! Your instance is now <a href="https://github.com/sadfun/wirebot">Wirebot</a>, the next evolution of telex.\n\n' +
  "Your login, conversations, memory, and schedules are preserved. Slack and Discord are now supported, and updates are automatic. Just keep chatting.";

export function migrationDirectory(config: Pick<Config, "dataDirectory">): string {
  const id = createHash("sha256").update(config.dataDirectory).digest("hex").slice(0, 12);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "telex-wirebot", id);
}

export async function assertTelexReleaseUpdatesAllowed(): Promise<void> {
  const directory = migrationDirectory({
    dataDirectory: resolve(process.env.TELEX_DATA_DIR ?? ".telex"),
  });
  if (await exists(join(directory, "migration.json"))) {
    throw new Error(
      "This instance has moved to Wirebot. The telex service updates its Docker image automatically; do not roll back Telex against the obsolete source snapshot. See README.md for recovery instructions.",
    );
  }
}

/** Called before starting ANY Telex resources, after the old release has shut down. */
export async function runWithWirebot<T>(runTelex: () => Promise<T>): Promise<T | undefined> {
  const config = loadAppConfig();
  const directory = migrationDirectory(config);
  const stateFile = join(directory, "migration.json");
  let state = await readState(stateFile);
  if (state === undefined && config.migrationMode === "off") return await runTelex();
  const logger = new Logger(config.logLevel, { component: "wirebot-migration" });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unlock = await acquireRuntimeLock(join(directory, "runtime.lock"));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let docker: Docker | undefined;
  try {
    // Read again under the lock: another launcher may just have completed migration.
    state = await readState(stateFile);
    if (state === undefined) {
      // Old releases have no PID lock. Reserve their HTTP port while taking the snapshot.
      const reservation = createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(config.port, config.host, resolve);
      });
      try {
        docker = await ensureDocker(directory, logger, abort.signal);
        logger.info("Pulling Wirebot before migrating; original Telex data will be retained");
        await docker.run(["pull", wirebotImage], abort.signal);
        const image = await docker.run(
          ["image", "inspect", "--format", "{{.Id}}", wirebotImage],
          abort.signal,
        );
        const prepared = await prepareMigration(config, directory, docker, image);
        await atomicWriteJson(stateFile, prepared);
        state = prepared;
      } catch (error) {
        logger.error(
          "Wirebot preparation failed; continuing to run Telex. Fix the error and restart the service to retry",
          error,
        );
      } finally {
        await new Promise<void>((resolve) => reservation.close(() => resolve()));
      }
    }

    if (state !== undefined) {
      docker ??= new Docker(state.dockerCommand);
      await docker.ensureRunning(abort.signal);
      // An active migration must never fall back to the obsolete source snapshot.
      if (state.status === "active") {
        state = await reconcileContainers(docker, stateFile, state);
        await startContainer(docker, state, abort.signal);
      } else {
        try {
          await startContainer(docker, state, abort.signal);
          const active = { ...state, status: "active" as const };
          await atomicWriteJson(stateFile, active);
          state = active;
          logger.info("Migrated to Wirebot; the Telex service now maintains its Docker image", {
            directory,
          });
        } catch (error) {
          // Cleanup must succeed before Telex can resume polling with its original state.
          await removeOwnedContainer(docker, state.name);
          await rm(stateFile);
          state = undefined;
          logger.error("Wirebot did not start; the original Telex instance is preserved", error);
        }
      }
    }

    if (state !== undefined && docker !== undefined) {
      while (!abort.signal.aborted) {
        state = await notifyMigratedUsers(config, stateFile, state, logger);
        try {
          await delay(config.updateIntervalMs, undefined, { signal: abort.signal });
          state = await updateWirebot(docker, stateFile, state, abort.signal, logger);
        } catch (error) {
          if (abort.signal.aborted) break;
          state = (await readState(stateFile)) ?? state;
          if (state.updating) throw error; // Let the service restart and finish restoring the snapshot.
          logger.error("Wirebot image update failed; keeping the previous image", error);
        }
      }
    } else if (!abort.signal.aborted) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      return await runTelex();
    }
    return undefined;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      if (abort.signal.aborted && state !== undefined && docker !== undefined) {
        await docker.run(["stop", "--time", "60", state.name]);
      }
    } finally {
      await unlock();
    }
  }
}

export async function prepareMigration(
  config: Config,
  directory: string,
  docker: Docker,
  image: string,
): Promise<MigrationState> {
  await mkdir(config.dataDirectory, { recursive: true });
  await mkdir(config.workspace, { recursive: true });
  const sourceData = await realpath(config.dataDirectory);
  const sourceWorkspace = await realpath(config.workspace);
  const root = await realpath(directory);
  if (within(sourceData, root) || within(sourceWorkspace, root)) {
    throw new Error(
      "The migration directory must be outside Telex's data and workspace; set XDG_DATA_HOME to a separate directory",
    );
  }
  const data = join(root, `data-${crypto.randomUUID()}`);
  await cp(sourceData, data, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  let workspace: string;
  if (within(sourceData, sourceWorkspace)) {
    workspace = join(data, relative(sourceData, sourceWorkspace));
  } else {
    workspace = join(data, ".telex-external-workspace");
    if (await exists(workspace))
      throw new Error("Reserved migration workspace path already exists");
    await cp(sourceWorkspace, workspace, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
  // Both names resolve to the same files, including paths embedded in old scheduled threads.
  if (await exists(join(workspace, ".telex"))) {
    if (await exists(join(workspace, ".wirebot"))) {
      throw new Error(
        "Both .telex and .wirebot already exist in the workspace; reconcile them before migrating",
      );
    }
    await symlink(".telex", join(workspace, ".wirebot"));
  }
  for (const [name, schema] of [
    ["conversations.json", conversationSchema],
    ["settings.json", settingsSchema],
    ["automations.json", automationSchema],
  ] as const) {
    const file = join(data, name);
    if (await exists(file))
      await atomicWriteJson(file, schema.parse(JSON.parse(await readFile(file, "utf8"))));
  }
  const authFile = join(data, "codex-home", "auth.json");
  const auth = (await exists(authFile)) ? JSON.parse(await readFile(authFile, "utf8")) : undefined;
  const codexConfig = join(data, "codex-home", "config.toml");
  if (await exists(codexConfig)) {
    const contents = await readFile(codexConfig, "utf8");
    const table = contents.search(/^\s*\[/mu);
    const rootConfig = table < 0 ? contents : contents.slice(0, table);
    // Wirebot uses the container as its sandbox. Nested bubblewrap cannot run in standard Docker.
    const migrated =
      rootConfig.replace(
        /^(\s*sandbox_mode\s*=\s*)(["'])workspace-write\2/gmu,
        '$1"danger-full-access"',
      ) + (table < 0 ? "" : contents.slice(table));
    if (migrated !== contents) await atomicWriteFile(codexConfig, migrated);
  }
  if (
    !auth &&
    (await exists(codexConfig)) &&
    /^\s*cli_auth_credentials_store\s*=\s*["'](?:keyring|auto)["']/mu.test(
      await readFile(codexConfig, "utf8"),
    )
  ) {
    throw new Error(
      'Codex credentials are in the host keychain. Set cli_auth_credentials_store = "file", sign in, and restart telex before migrating',
    );
  }
  const environment = await migrationEnvironment(config);
  const envFile = join(root, "wirebot.env");
  await atomicWriteFile(envFile, environment);
  const mounts = new Map<string, string>([["/data", data]]);
  if (
    [config.dataDirectory, sourceData, config.workspace, sourceWorkspace].some((path) =>
      within("/root", path),
    )
  ) {
    // The image's /root is mode 0700; root-owned Telex installs must remain reachable by UID 1000.
    await mkdir(join(data, "home"), { recursive: true, mode: 0o700 });
    mounts.set("/root", join(data, "home"));
  }
  for (const destination of new Set([config.dataDirectory, sourceData]))
    mounts.set(destination, data);
  for (const destination of new Set([config.workspace, sourceWorkspace]))
    mounts.set(destination, workspace);
  // Original absolute paths preserve SQLite rollout paths, config references, and thread cwd.
  const mountArgs = [...mounts].flatMap(([destination, source]) => {
    if (
      [
        "/",
        "/etc",
        "/usr",
        "/bin",
        "/opt",
        "/opt/wirebot",
        "/proc",
        "/sys",
        "/dev",
        "/data/home",
      ].some(
        (reserved) =>
          destination === reserved || (reserved !== "/" && within(reserved, destination)),
      )
    ) {
      throw new Error(`Cannot preserve the host path ${destination} inside the Wirebot image`);
    }
    return ["--mount", bindMount(source, destination)];
  });
  const host = (await lookup(config.host)).address;
  const id = createHash("sha256").update(config.dataDirectory).digest("hex").slice(0, 12);
  const name = `telex-wirebot-${id}`;
  return stateSchema.parse({
    version: 1,
    status: "prepared",
    name,
    image,
    dockerCommand: docker.command,
    dataDirectory: data,
    updating: false,
    runArguments: [
      "--name",
      name,
      "--label",
      `${ownerLabel}=${name}`,
      "--restart",
      "unless-stopped",
      "--log-opt",
      "max-size=10m",
      "--log-opt",
      "max-file=3",
      "--env-file",
      envFile,
      "--publish",
      `${host.includes(":") ? `[${host}]` : host}:${config.port}:8787`,
      ...mountArgs,
    ],
    expectAuthentication: Boolean(auth?.tokens?.access_token || auth?.OPENAI_API_KEY),
    notifiedUserIds: [],
  });
}

export async function migrationEnvironment(config: Config): Promise<string> {
  // Retain extra keys from the actual --env-file(s), including custom MCP/provider credentials.
  const environment: Record<string, string> = {};
  for (const argument of process.execArgv) {
    const match = /^--env-file(?:-if-exists)?=(.+)$/.exec(argument);
    if (match?.[1] !== undefined && (await exists(resolve(match[1])))) {
      for (const [key, value] of Object.entries(
        parseEnv(await readFile(resolve(match[1]), "utf8")),
      )) {
        if (value !== undefined) environment[key] = process.env[key] ?? value;
      }
    }
  }
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("TELEX_") ||
      [
        "HOME",
        "PATH",
        "USER",
        "LOGNAME",
        "SHELL",
        "CODEX_HOME",
        "WIREBOT_TOOLCHAINS_DIR",
        "WIREBOT_ASSETS_DIR",
      ].includes(key)
    )
      delete environment[key];
  }
  Object.assign(environment, {
    TELEGRAM_BOT_TOKEN: config.telegramToken,
    TELEGRAM_ALLOWED_USER_IDS: [...config.allowedUserIds].join(","),
    TELEGRAM_API_BASE: config.telegramApiBase,
    TELEGRAM_POLL_TIMEOUT: String(config.telegramPollTimeout),
    WIREBOT_TUNNEL: config.tunnelMode,
    WIREBOT_CONTAINER: "1",
    CODEX_CHECK_UPDATES: "false",
    WIREBOT_DATA_DIR: config.dataDirectory,
    CODEX_WORKSPACE: config.workspace,
    HOST: "0.0.0.0",
    PORT: "8787",
    // Startup verification needs Wirebot's structured ready event.
    LOG_LEVEL: config.logLevel === "debug" ? "debug" : "info",
    ...(config.publicUrl === undefined ? {} : { PUBLIC_URL: config.publicUrl }),
  });
  return Object.entries(environment)
    .map(([key, value]) => {
      if (/[\r\n\0]/u.test(value))
        throw new Error(
          `Docker env files cannot preserve multiline ${key}; configure this value as a file before migrating`,
        );
      return `${key}=${value}\n`;
    })
    .join("");
}

export async function updateWirebot(
  docker: Docker,
  stateFile: string,
  state: MigrationState,
  signal: AbortSignal,
  logger: Logger,
): Promise<MigrationState> {
  state = await reconcileContainers(docker, stateFile, state);
  await docker.run(["pull", wirebotImage], signal);
  const image = await docker.run(["image", "inspect", "--format", "{{.Id}}", wirebotImage], signal);
  if (image === state.image) return state;
  const previous = `${state.name}-previous`;
  await ownedContainer(docker, state.name);
  try {
    await docker.run(["stop", "--time", "60", state.name], signal);
    await docker.copyData(
      state.dataDirectory,
      `${state.dataDirectory}-backup`,
      state.image,
      signal,
    );
    const pending = { ...state, updating: true };
    await atomicWriteJson(stateFile, pending);
    state = pending;
    await docker.run(["rename", state.name, previous], signal);
    await startContainer(docker, { ...state, image }, signal);
    const candidate = { ...state, image, updating: false };
    await atomicWriteJson(stateFile, candidate);
    state = candidate;
    logger.info("Updated Wirebot image", { image });
  } catch (error) {
    state = await reconcileContainers(docker, stateFile, state);
    await docker.run(["start", state.name]);
    throw error;
  }
  await removeOwnedContainer(docker, previous);
  return state;
}

async function reconcileContainers(
  docker: Docker,
  stateFile: string,
  state: MigrationState,
): Promise<MigrationState> {
  const previous = `${state.name}-previous`;
  const prior = await ownedContainer(docker, previous);
  const current = await ownedContainer(docker, state.name);
  if (state.updating) {
    if (current?.State.Running) await docker.run(["stop", "--time", "60", state.name]);
    if (prior !== undefined) {
      await removeOwnedContainer(docker, state.name);
      await docker.run(["rename", previous, state.name]);
    }
    await docker.copyData(`${state.dataDirectory}-backup`, state.dataDirectory, state.image);
    state = { ...state, updating: false };
    await atomicWriteJson(stateFile, state);
  } else if (prior !== undefined && current?.Image === state.image) {
    await removeOwnedContainer(docker, previous);
  } else if (prior !== undefined) {
    await removeOwnedContainer(docker, state.name);
    await docker.run(["rename", previous, state.name]);
  }
  return state;
}

async function startContainer(
  docker: Docker,
  state: MigrationState,
  signal: AbortSignal,
): Promise<void> {
  const container = await ownedContainer(docker, state.name);
  if (container === undefined)
    await docker.run(["run", "--detach", ...state.runArguments, state.image], signal);
  else if (!container.State.Running) await docker.run(["start", state.name], signal);
  await docker.waitUntilReady(
    state.name,
    state.status === "prepared" && state.expectAuthentication,
    signal,
  );
}

async function ownedContainer(docker: Docker, name: string) {
  const container = await docker.container(name);
  if (
    container !== undefined &&
    container.Config.Labels?.[ownerLabel] !== name.replace(/-previous$/u, "")
  ) {
    throw new Error(`Container ${name} belongs to another application; refusing to change it`);
  }
  return container;
}

async function removeOwnedContainer(docker: Docker, name: string): Promise<void> {
  if ((await ownedContainer(docker, name)) !== undefined) await docker.run(["rm", "--force", name]);
}

async function notifyMigratedUsers(
  config: Config,
  file: string,
  state: MigrationState,
  logger: Logger,
): Promise<MigrationState> {
  const api = new Api(config.telegramToken, {
    apiRoot: config.telegramApiBase,
    timeoutSeconds: 15,
  });
  for (const userId of config.allowedUserIds) {
    if (state.notifiedUserIds.includes(userId)) continue;
    try {
      await api.sendMessage(userId, migrationMessage, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      const notified = { ...state, notifiedUserIds: [...state.notifiedUserIds, userId] };
      await atomicWriteJson(file, notified);
      state = notified;
    } catch {
      logger.warn("Could not deliver the Wirebot migration notice; will retry", { userId });
    }
  }
  return state;
}

async function readState(file: string): Promise<MigrationState | undefined> {
  return (await exists(file))
    ? stateSchema.parse(JSON.parse(await readFile(file, "utf8")))
    : undefined;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function acquireRuntimeLock(file: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(file, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error(`Invalid migration lock at ${file}; remove it only after stopping telex`);
      try {
        process.kill(pid, 0);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
          await rm(file);
          continue;
        }
        throw probeError;
      }
      throw new Error(`Telex or its Wirebot updater is already running (PID ${pid})`);
    }
  }
  throw new Error(`Could not acquire migration lock: ${file}`);
}
