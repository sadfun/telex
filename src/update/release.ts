import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { BridgeError } from "../shared/errors.js";
import { ensureDirectory } from "../shared/fs.js";
import type { Logger } from "../shared/logger.js";
import { runCommand } from "../shared/process.js";

const githubAssetSchema = z.object({
  name: z.string().min(1),
  browser_download_url: z.url(),
  size: z.number().int().nonnegative(),
});

const githubReleaseSchema = z.object({
  tag_name: z.string().min(1),
  draft: z.boolean(),
  prerelease: z.boolean(),
  html_url: z.url(),
  assets: z.array(githubAssetSchema),
});

const packageSchema = z.object({
  name: z.literal("telex"),
  version: z.string(),
});

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const maximumAssetBytes = 250 * 1024 * 1024;
const staleLockMilliseconds = 15 * 60 * 1_000;

interface GithubAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
}

export interface TelexRelease {
  readonly version: string;
  readonly pageUrl: string;
  readonly archive: GithubAsset;
  readonly checksum: GithubAsset;
}

export interface UpdateStatus {
  readonly currentVersion: string;
  readonly release: TelexRelease;
  readonly updateAvailable: boolean;
}

export interface InstalledUpdate {
  readonly previousVersion: string;
  readonly version: string;
  readonly releaseDirectory: string;
}

interface ReleaseUpdaterOptions {
  readonly repository: string;
  readonly currentVersion: string;
  readonly installDirectory?: string;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
}

export class ReleaseUpdater {
  readonly #repository: string;
  readonly #currentVersion: string;
  readonly #installDirectory: string | undefined;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;

  public constructor(options: ReleaseUpdaterOptions) {
    if (!repositoryPattern.test(options.repository)) {
      throw new BridgeError(
        `Invalid GitHub repository ${options.repository}; expected owner/repository`,
        "INVALID_UPDATE_REPOSITORY",
      );
    }
    parseVersion(options.currentVersion);
    this.#repository = options.repository;
    this.#currentVersion = options.currentVersion;
    this.#installDirectory = options.installDirectory;
    this.#logger = options.logger;
    this.#fetch = options.fetch ?? fetch;
  }

  public async check(requestedVersion = "latest", signal?: AbortSignal): Promise<UpdateStatus> {
    const release = await this.fetchRelease(requestedVersion, signal);
    return {
      currentVersion: this.#currentVersion,
      release,
      updateAvailable: compareVersions(release.version, this.#currentVersion) > 0,
    };
  }

  public async install(release: TelexRelease, signal?: AbortSignal): Promise<InstalledUpdate> {
    const installDirectory = this.requireInstallDirectory();
    const lockDirectory = await acquireUpdateLock(installDirectory);

    const downloadDirectory = join(installDirectory, ".downloads");
    const archivePath = join(downloadDirectory, release.archive.name);
    const checksumPath = join(downloadDirectory, release.checksum.name);
    const stageDirectory = join(
      installDirectory,
      "releases",
      `.${release.version}-${crypto.randomUUID()}`,
    );

    try {
      await ensureDirectory(downloadDirectory);
      await Promise.all([
        this.downloadAsset(release.archive, archivePath, signal),
        this.downloadAsset(release.checksum, checksumPath, signal),
      ]);
      await verifyChecksum(archivePath, checksumPath, release.archive.name);

      await ensureDirectory(stageDirectory);
      await runCommand("tar", ["-xzf", archivePath, "-C", stageDirectory], {
        cwd: stageDirectory,
      });
      await validateReleaseDirectory(stageDirectory, release.version);

      const releasesDirectory = join(installDirectory, "releases");
      const releaseDirectory = join(releasesDirectory, release.version);
      await ensureDirectory(releasesDirectory);
      let releaseAlreadyExists = false;
      try {
        await lstat(releaseDirectory);
        releaseAlreadyExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (releaseAlreadyExists) {
        await validateReleaseDirectory(releaseDirectory, release.version);
        await rm(stageDirectory, { recursive: true, force: true });
      } else {
        await rename(stageDirectory, releaseDirectory);
      }

      const previousVersion = await this.activate(release.version);
      this.#logger.info("Installed Telex update", {
        previousVersion,
        version: release.version,
      });
      return { previousVersion, version: release.version, releaseDirectory };
    } finally {
      await Promise.all([
        rm(stageDirectory, { recursive: true, force: true }),
        rm(archivePath, { force: true }),
        rm(checksumPath, { force: true }),
        rm(lockDirectory, { recursive: true, force: true }),
      ]);
    }
  }

  public async rollback(version: string): Promise<InstalledUpdate> {
    const normalizedVersion = normalizeVersion(version);
    const installDirectory = this.requireInstallDirectory();
    const lockDirectory = await acquireUpdateLock(installDirectory);
    try {
      const releaseDirectory = join(installDirectory, "releases", normalizedVersion);
      await validateReleaseDirectory(releaseDirectory, normalizedVersion);
      const previousVersion = await this.activate(normalizedVersion);
      return { previousVersion, version: normalizedVersion, releaseDirectory };
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }

  private async fetchRelease(
    requestedVersion: string,
    signal?: AbortSignal,
  ): Promise<TelexRelease> {
    const suffix =
      requestedVersion === "latest"
        ? "latest"
        : `tags/${encodeURIComponent(`v${normalizeVersion(requestedVersion)}`)}`;
    const response = await this.#fetch(
      `https://api.github.com/repos/${this.#repository}/releases/${suffix}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `telex/${this.#currentVersion}`,
          "x-github-api-version": "2022-11-28",
        },
        signal: requestSignal(signal),
      },
    );
    if (!response.ok) {
      throw new BridgeError(
        `GitHub returned ${response.status} while checking Telex releases`,
        "RELEASE_CHECK_FAILED",
      );
    }

    const githubRelease = githubReleaseSchema.parse(await response.json());
    if (githubRelease.draft) {
      throw new BridgeError("Refusing to install a draft GitHub release", "INVALID_RELEASE");
    }
    if (requestedVersion === "latest" && githubRelease.prerelease) {
      throw new BridgeError("GitHub returned a prerelease as latest", "INVALID_RELEASE");
    }

    const version = normalizeVersion(githubRelease.tag_name);
    const archiveName = `telex-${version}.tar.gz`;
    const checksumName = `${archiveName}.sha256`;
    const archive = githubRelease.assets.find((asset) => asset.name === archiveName);
    const checksum = githubRelease.assets.find((asset) => asset.name === checksumName);
    if (archive === undefined || checksum === undefined) {
      throw new BridgeError(
        `Release v${version} does not contain ${archiveName} and ${checksumName}`,
        "RELEASE_ASSETS_MISSING",
      );
    }
    if (archive.size > maximumAssetBytes) {
      throw new BridgeError(`Release asset ${archiveName} is too large`, "RELEASE_ASSET_TOO_LARGE");
    }
    return {
      version,
      pageUrl: githubRelease.html_url,
      archive,
      checksum,
    };
  }

  private async downloadAsset(
    asset: GithubAsset,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#fetch(asset.browser_download_url, {
      headers: { "user-agent": `telex/${this.#currentVersion}` },
      redirect: "follow",
      signal: requestSignal(signal),
    });
    if (!response.ok) {
      throw new BridgeError(
        `GitHub returned ${response.status} while downloading ${asset.name}`,
        "RELEASE_DOWNLOAD_FAILED",
      );
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maximumAssetBytes || data.byteLength !== asset.size) {
      throw new BridgeError(
        `Downloaded size for ${asset.name} did not match the GitHub release`,
        "RELEASE_SIZE_MISMATCH",
      );
    }
    await writeFile(destination, data, { mode: 0o600 });
  }

  private async activate(version: string): Promise<string> {
    const installDirectory = this.requireInstallDirectory();
    const currentPath = join(installDirectory, "current");
    const temporaryPath = join(installDirectory, `.current-${crypto.randomUUID()}`);
    const previousVersion = await activeVersion(currentPath);
    await symlink(join("releases", version), temporaryPath, "dir");
    try {
      await rename(temporaryPath, currentPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return previousVersion ?? this.#currentVersion;
  }

  private requireInstallDirectory(): string {
    if (this.#installDirectory === undefined) {
      throw new BridgeError(
        "Telex was not installed by the release installer; update this source checkout with Git instead",
        "NOT_RELEASE_INSTALL",
      );
    }
    return this.#installDirectory;
  }
}

export function normalizeVersion(value: string): string {
  const parsed = parseVersion(value);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease === undefined ? "" : `-${parsed.prerelease}`}`;
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = leftVersion[key] - rightVersion[key];
    if (difference !== 0) return Math.sign(difference);
  }
  if (leftVersion.prerelease === rightVersion.prerelease) return 0;
  if (leftVersion.prerelease === undefined) return 1;
  if (rightVersion.prerelease === undefined) return -1;
  return leftVersion.prerelease.localeCompare(rightVersion.prerelease, "en", { numeric: true });
}

async function verifyChecksum(
  archivePath: string,
  checksumPath: string,
  expectedName: string,
): Promise<void> {
  const checksumContents = (await readFile(checksumPath, "utf8")).trim();
  const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(checksumContents);
  if (match === null || basename(match[2] ?? "") !== expectedName) {
    throw new BridgeError("Release checksum file has an invalid format", "INVALID_CHECKSUM_FILE");
  }
  const expected = match[1]?.toLowerCase();
  const actual = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  if (actual !== expected) {
    throw new BridgeError("Telex release checksum verification failed", "CHECKSUM_MISMATCH");
  }
}

async function validateReleaseDirectory(directory: string, expectedVersion: string): Promise<void> {
  const packageJson = packageSchema.parse(
    JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
  );
  if (packageJson.version !== expectedVersion) {
    throw new BridgeError(
      `Release package version ${packageJson.version} does not match v${expectedVersion}`,
      "RELEASE_VERSION_MISMATCH",
    );
  }
  await Promise.all([
    lstat(join(directory, "dist", "cli", "main.js")),
    lstat(join(directory, "dist", "index.js")),
    lstat(join(directory, "codex.version")),
    lstat(join(directory, "node_modules")),
  ]);
}

async function activeVersion(currentPath: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(currentPath);
    if (!metadata.isSymbolicLink()) {
      throw new BridgeError(
        `${currentPath} is not an installer-managed symlink`,
        "INVALID_INSTALL",
      );
    }
    return basename(await readlink(currentPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseVersion(value: string): {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | undefined;
} {
  const match = versionPattern.exec(value);
  if (match === null) {
    throw new BridgeError(`Invalid Telex version: ${value}`, "INVALID_VERSION");
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function acquireUpdateLock(installDirectory: string): Promise<string> {
  const lockDirectory = join(installDirectory, ".update.lock");
  await ensureDirectory(installDirectory);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDirectory);
      return lockDirectory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lockDirectory)).mtimeMs;
      if (age <= staleLockMilliseconds) {
        throw new BridgeError("Another Telex update is already running", "UPDATE_IN_PROGRESS");
      }
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }
  throw new BridgeError("Could not acquire the Telex update lock", "UPDATE_IN_PROGRESS");
}
