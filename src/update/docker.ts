import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { externalProcessEnvironment } from "../shared/environment.js";
import { atomicWriteFile } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";
import { runCommand } from "../shared/process.js";

export const wirebotImage = "ghcr.io/sadfun/wirebot:latest";
export function bindMount(source: string, target: string, readonly = false): string {
  return ["type=bind", `source=${source}`, `target=${target}`, ...(readonly ? ["readonly"] : [])]
    .map((field) => `"${field.replaceAll('"', '""')}"`)
    .join(",");
}
const installerRevision = "4e16be805b3af595aa448d1a4def857841f1c62c";
const installerSha256 = "f51e472f1ffb1cf2516a9fd55ab7d7d1ed8d07288d31dce93de3c66524b92997";
const containerSchema = z.object({
  Image: z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({ Running: z.boolean(), Restarting: z.boolean(), StartedAt: z.string() }),
});

function commandEnvironment(): NodeJS.ProcessEnv {
  return externalProcessEnvironment({
    PATH: [
      process.env.PATH,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]
      .filter(Boolean)
      .join(delimiter),
    NONINTERACTIVE: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1",
  });
}

async function executable(name: string): Promise<string | undefined> {
  for (const directory of (commandEnvironment().PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry, including Homebrew's paths in launchd sessions.
    }
  }
  return undefined;
}

async function command(args: readonly string[], signal?: AbortSignal): Promise<string> {
  const [program, ...rest] = args;
  if (program === undefined) throw new Error("Missing command");
  const environment = commandEnvironment();
  if (args.includes("--host")) {
    delete environment.DOCKER_HOST;
    delete environment.DOCKER_CONTEXT;
    delete environment.DOCKER_TLS_VERIFY;
  }
  const result = await runCommand(program, rest, {
    cwd: "/",
    env: environment,
    timeout: 20 * 60_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.stdout.trim();
}

/** The endpoint is pinned so a later `docker context use` cannot move this bot. */
export class Docker {
  public readonly command: readonly string[];

  public constructor(command: readonly string[]) {
    this.command = command;
  }

  public async run(args: readonly string[], signal?: AbortSignal): Promise<string> {
    return await command([...this.command, ...args], signal);
  }

  public async ensureRunning(signal: AbortSignal): Promise<void> {
    try {
      await this.run(["info"], signal);
      return;
    } catch {
      signal.throwIfAborted();
    }
    const host = this.command[this.command.indexOf("--host") + 1] ?? "";
    if (process.platform === "darwin") {
      if (host.includes("/.colima/")) {
        const colima = await executable("colima");
        if (colima === undefined) throw new Error("Start the Colima daemon used by Wirebot");
        await command(
          [colima, "start", "--profile", basename(dirname(new URL(host).pathname))],
          signal,
        );
      } else {
        await command(["/usr/bin/open", "-a", "Docker"], signal);
      }
    } else if (host.includes("/run/user/")) {
      await command(["systemctl", "--user", "start", "docker"], signal);
    } else {
      await command(
        [...(process.getuid?.() === 0 ? [] : ["sudo", "-n"]), "systemctl", "start", "docker"],
        signal,
      );
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await this.run(["info"], signal);
        return;
      } catch {
        await delay(2_000, undefined, { signal });
      }
    }
    throw new Error("Wirebot's Docker daemon is unavailable");
  }

  public async container(name: string) {
    const id = await this.run(["container", "ls", "-aq", "--filter", `name=^/${name}$`]);
    if (!id) return undefined;
    return containerSchema.parse(JSON.parse(await this.run(["inspect", name]))[0]);
  }

  /** Copy with container ownership intact; the host user need not own files under /data. */
  public async copyData(
    source: string,
    destination: string,
    image: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const name = `telex-wirebot-copy-${createHash("sha256").update([source, destination].sort().join("\0")).digest("hex").slice(0, 12)}`;
    const existing = await this.container(name);
    if (existing !== undefined) {
      if (existing.Config.Labels?.["io.github.sadfun.telex-copy"] !== name)
        throw new Error(`Container ${name} belongs to another application`);
      await this.run(["rm", "--force", name]);
    }
    await this.run(
      [
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        `io.github.sadfun.telex-copy=${name}`,
        "--network",
        "none",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "--mount",
        bindMount(source, "/source", true),
        "--mount",
        bindMount(destination, "/destination"),
        image,
        "-c",
        "find /destination -mindepth 1 -delete && cp -a /source/. /destination/",
      ],
      signal,
    );
  }

  public async waitUntilReady(
    name: string,
    expectAuthentication: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const container = await this.container(name);
      if (container === undefined || !container.State.Running || container.State.Restarting) {
        throw new Error("Wirebot exited before it was ready; inspect its Docker logs");
      }
      // /healthz starts before the connectors. The ready log confirms polling and schedules too.
      const logs = await this.run(["logs", "--since", container.State.StartedAt, name], signal);
      const ready = logs.split("\n").some((line) => {
        try {
          return JSON.parse(line).message === "Wirebot is ready";
        } catch {
          return false;
        }
      });
      if (ready) {
        const health = JSON.parse(
          await this.run(
            [
              "exec",
              name,
              "curl",
              "--fail",
              "--silent",
              "--max-time",
              "10",
              "http://127.0.0.1:8787/healthz",
            ],
            signal,
          ),
        );
        if (
          health.ok === true &&
          (health.codex === "authenticated" ||
            (!expectAuthentication && ["needs_login", "not_required"].includes(health.codex)))
        )
          return;
      }
      await delay(2_000, undefined, { signal });
    }
    throw new Error(
      "Wirebot did not become ready with the migrated Codex account within 3 minutes",
    );
  }
}

/** Installs only when missing. Unattended services never wait for a sudo password. */
export async function ensureDocker(
  directory: string,
  logger: Logger,
  signal: AbortSignal,
): Promise<Docker> {
  if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("Wirebot requires Linux or macOS on x86-64 or ARM64");
  }
  let binary = await executable("docker");
  if (binary !== undefined) {
    const host =
      process.env.DOCKER_HOST ??
      (await command(
        [binary, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        signal,
      ));
    if (!host.startsWith("unix://")) {
      throw new Error(
        "Migration requires a local Docker Unix socket; remote daemons cannot mount this user's data",
      );
    }
    const docker = new Docker([binary, "--host", host]);
    try {
      await docker.run(["info"], signal);
      return docker;
    } catch {
      signal.throwIfAborted();
      if (process.env.DOCKER_HOST !== undefined) {
        throw new Error(
          "The configured DOCKER_HOST is unavailable; start that Docker daemon and restart telex",
        );
      }
    }
  }

  logger.info("Preparing Docker for Wirebot");
  if (process.platform === "darwin") {
    try {
      await access("/Applications/Docker.app");
      await command(["/usr/bin/open", "-a", "Docker"], signal);
    } catch {
      const brew = await executable("brew");
      if (brew === undefined) {
        throw new Error(
          "Install Homebrew or start Docker Desktop, then restart telex to finish migrating",
        );
      }
      await command([brew, "install", "docker", "colima"], signal);
      const colima = await executable("colima");
      if (colima === undefined) throw new Error("Homebrew did not install Colima");
      await command([colima, "start", "--mount", `${directory}:w`], signal);
      await command([brew, "services", "start", "colima"], signal);
    }
    binary = await executable("docker");
    if (binary === undefined) throw new Error("Docker CLI is missing after installation");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const host = await command(
          [binary, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
          signal,
        );
        if (!host.startsWith("unix://")) throw new Error("Docker must use a local Unix socket");
        const docker = new Docker([binary, "--host", host]);
        await docker.run(["info"], signal);
        return docker;
      } catch {
        await delay(2_000, undefined, { signal });
      }
    }
    throw new Error("Docker did not start; start Docker Desktop or Colima and restart telex");
  }

  // Rootless Docker may simply need its existing user service restarted.
  if (binary !== undefined) {
    try {
      await command(["systemctl", "--user", "start", "docker"], signal);
      const host = await command(
        [binary, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        signal,
      );
      if (host.startsWith("unix://")) {
        const docker = new Docker([binary, "--host", host]);
        await docker.run(["info"], signal);
        return docker;
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  const privilege = process.getuid?.() === 0 ? [] : ["sudo", "-n"];
  if (binary !== undefined) {
    try {
      const docker = new Docker([...privilege, binary, "--host", "unix:///var/run/docker.sock"]);
      await docker.run(["info"], signal);
      return docker;
    } catch {
      signal.throwIfAborted();
    }
  }
  try {
    await command([...privilege, "true"], signal);
  } catch {
    throw new Error(
      "Docker setup needs root or passwordless sudo. Install/start Docker for this user, then restart telex",
    );
  }
  if (binary === undefined) {
    const response = await fetch(
      `https://raw.githubusercontent.com/docker/docker-install/${installerRevision}/install.sh`,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      },
    );
    if (!response.ok) throw new Error("Could not download the Docker installer");
    const script = await response.text();
    if (createHash("sha256").update(script).digest("hex") !== installerSha256) {
      throw new Error("Docker installer checksum mismatch");
    }
    const installer = join(directory, "install-docker.sh");
    await atomicWriteFile(installer, script);
    await command([...privilege, "sh", installer], signal);
    binary = await executable("docker");
  }
  if (binary === undefined) throw new Error("Docker CLI is missing after installation");
  await command([...privilege, "systemctl", "enable", "--now", "docker"], signal);
  const docker = new Docker([...privilege, binary, "--host", "unix:///var/run/docker.sock"]);
  await docker.run(["info"], signal);
  return docker;
}
