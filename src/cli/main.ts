#!/usr/bin/env node

import { checkCodexProtocol, formatProtocolCheck } from "../codex/protocol-upgrade.js";
import { loadUpdateConfig } from "../config/env.js";
import { errorMessage } from "../shared/errors.js";
import { projectRootFrom } from "../shared/fs.js";
import { Logger } from "../shared/logger.js";
import { readTelexVersion } from "../shared/version.js";
import { ReleaseUpdater } from "../update/release.js";

interface CodexCheckArguments {
  readonly version: string;
  readonly apply: boolean;
}

interface UpdateArguments {
  readonly version: string;
  readonly checkOnly: boolean;
  readonly rollback: string | undefined;
}

const usage = `Usage:
  telex start
  telex version
  telex update [--check] [--version latest|VERSION]
  telex update --rollback VERSION
  telex codex check [--version latest|VERSION] [--apply]

Application updates are verified GitHub Release bundles. Automatic and manual
installation require setup through the release installer. Codex protocol checks
are maintainer commands for updating the separately pinned Codex CLI.`;

async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(usage);
    return args.length === 0 ? 1 : 0;
  }

  switch (args[0]) {
    case "start": {
      if (args.length !== 1) throw new Error(usage);
      const { runTelex } = await import("../index.js");
      const result = await runTelex();
      return result.reason === "updated" ? 75 : 0;
    }
    case "version": {
      if (args.length !== 1) throw new Error(usage);
      console.log(await readTelexVersion(projectRootFrom(import.meta.url)));
      return 0;
    }
    case "update":
      return await updateTelex(parseUpdateArguments(args));
    case "codex":
      return await checkCodex(parseCodexArguments(args));
    default:
      throw new Error(usage);
  }
}

async function updateTelex(args: UpdateArguments): Promise<number> {
  const projectRoot = projectRootFrom(import.meta.url);
  const config = loadUpdateConfig();
  const currentVersion = await readTelexVersion(projectRoot);
  const updater = new ReleaseUpdater({
    repository: config.updateRepository,
    currentVersion,
    ...(config.installDirectory === undefined ? {} : { installDirectory: config.installDirectory }),
    logger: new Logger("info", { component: "updater" }),
  });

  if (args.rollback !== undefined) {
    const installed = await updater.rollback(args.rollback);
    console.log(
      `Activated Telex ${installed.version} (previously ${installed.previousVersion}). Restart the Telex service to use it.`,
    );
    return 0;
  }

  const status = await updater.check(args.version);
  if (args.checkOnly) {
    if (status.updateAvailable) {
      console.log(
        `Telex ${status.release.version} is available (installed: ${status.currentVersion}).\n${status.release.pageUrl}`,
      );
      return 10;
    }
    console.log(`Telex ${status.currentVersion} is current.`);
    return 0;
  }

  if (args.version === "latest" && !status.updateAvailable) {
    console.log(`Telex ${status.currentVersion} is already current.`);
    return 0;
  }
  const installed = await updater.install(status.release);
  console.log(
    `Installed Telex ${installed.version} (previously ${installed.previousVersion}). Restart the Telex service to use it.`,
  );
  return 0;
}

async function checkCodex(args: CodexCheckArguments): Promise<number> {
  const result = await checkCodexProtocol({
    projectRoot: projectRootFrom(import.meta.url),
    requestedVersion: args.version,
    apply: args.apply,
    logger: new Logger("info", { component: "protocol-check" }),
  });
  console.log(formatProtocolCheck(result));
  if (args.apply && result.compatible && !result.applied) return 1;
  return result.compatible ? 0 : 2;
}

function parseUpdateArguments(args: readonly string[]): UpdateArguments {
  let version = "latest";
  let checkOnly = false;
  let rollback: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      checkOnly = true;
      continue;
    }
    if (argument === "--version" || argument === "--rollback") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a version`);
      }
      if (argument === "--version") version = value;
      else rollback = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ""}\n\n${usage}`);
  }
  if (rollback !== undefined && (checkOnly || version !== "latest")) {
    throw new Error("--rollback cannot be combined with --check or --version");
  }
  return { version, checkOnly, rollback };
}

function parseCodexArguments(args: readonly string[]): CodexCheckArguments {
  if (args[0] !== "codex" || args[1] !== "check") throw new Error(usage);
  let version = "latest";
  let apply = false;
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--version") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--version requires latest or an exact Codex version");
      }
      version = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ""}\n\n${usage}`);
  }
  return { version, apply };
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
