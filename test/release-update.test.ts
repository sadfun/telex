import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../src/shared/logger.js";
import { compareVersions, normalizeVersion, ReleaseUpdater } from "../src/update/release.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("release versions", () => {
  it("normalizes tags and compares stable and prerelease versions", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });
});

describe("ReleaseUpdater", () => {
  it("checks, verifies, installs, and atomically activates a GitHub release", async () => {
    const root = await mkdtemp(join(tmpdir(), "telex-update-test-"));
    temporaryDirectories.push(root);
    const bundle = join(root, "bundle");
    const install = join(root, "install");
    await Promise.all([
      mkdir(join(bundle, "dist", "cli"), { recursive: true }),
      mkdir(join(bundle, "node_modules"), { recursive: true }),
      mkdir(join(install, "releases", "1.0.0"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(bundle, "package.json"), '{"name":"telex","version":"1.1.0"}\n'),
      writeFile(join(bundle, "dist", "cli", "main.js"), ""),
      writeFile(join(bundle, "dist", "index.js"), ""),
      writeFile(join(bundle, "codex.version"), "1.2.3\n"),
    ]);
    await symlink(join("releases", "1.0.0"), join(install, "current"), "dir");

    const archive = join(root, "telex-1.1.0.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
    const archiveBytes = await readFile(archive);
    const checksum = `${createHash("sha256").update(archiveBytes).digest("hex")}  telex-1.1.0.tar.gz\n`;
    const fakeFetch = releaseFetch(archiveBytes, checksum);
    const updater = new ReleaseUpdater({
      repository: "example/telex",
      currentVersion: "1.0.0",
      installDirectory: install,
      logger: new Logger("error"),
      fetch: fakeFetch,
    });

    const status = await updater.check();
    expect(status.updateAvailable).toBe(true);
    const installed = await updater.install(status.release);

    expect(installed.previousVersion).toBe("1.0.0");
    expect(installed.version).toBe("1.1.0");
    expect(await readlink(join(install, "current"))).toBe(join("releases", "1.1.0"));
    expect(
      JSON.parse(await readFile(join(installed.releaseDirectory, "package.json"), "utf8")),
    ).toEqual({ name: "telex", version: "1.1.0" });
  });

  it("refuses to install when the release checksum is wrong", async () => {
    const root = await mkdtemp(join(tmpdir(), "telex-update-test-"));
    temporaryDirectories.push(root);
    const updater = new ReleaseUpdater({
      repository: "example/telex",
      currentVersion: "1.0.0",
      installDirectory: join(root, "install"),
      logger: new Logger("error"),
      fetch: releaseFetch(Buffer.from("not a tarball"), `${"0".repeat(64)}  telex-1.1.0.tar.gz\n`),
    });

    const status = await updater.check();
    await expect(updater.install(status.release)).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
    });
  });
});

function releaseFetch(archive: Uint8Array, checksum: string): typeof fetch {
  return async (input): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("api.github.com")) {
      return Response.json({
        tag_name: "v1.1.0",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/example/telex/releases/tag/v1.1.0",
        assets: [
          {
            name: "telex-1.1.0.tar.gz",
            browser_download_url: "https://downloads.example/telex-1.1.0.tar.gz",
            size: archive.byteLength,
          },
          {
            name: "telex-1.1.0.tar.gz.sha256",
            browser_download_url: "https://downloads.example/telex-1.1.0.tar.gz.sha256",
            size: Buffer.byteLength(checksum),
          },
        ],
      });
    }
    if (url.endsWith(".sha256")) return new Response(checksum);
    return new Response(archive as unknown as BodyInit);
  };
}
