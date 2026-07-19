import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("release installer", () => {
  it("installs a verified bundle and creates a working stable launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "telex-installer-test-"));
    temporaryDirectories.push(root);
    const bundle = join(root, "bundle");
    const fixtures = join(root, "fixtures");
    const fakeBin = join(root, "fake-bin");
    await Promise.all([
      mkdir(join(bundle, "dist", "cli"), { recursive: true }),
      mkdir(join(bundle, "node_modules"), { recursive: true }),
      mkdir(fixtures),
      mkdir(fakeBin),
    ]);
    await Promise.all([
      writeFile(join(bundle, "package.json"), '{"name":"telex","version":"1.2.0"}\n'),
      writeFile(join(bundle, "dist", "cli", "main.js"), 'console.log("1.2.0");\n'),
      writeFile(join(bundle, "dist", "index.js"), ""),
      writeFile(join(bundle, "codex.version"), "1.2.3\n"),
    ]);

    const archiveName = "telex-1.2.0.tar.gz";
    const archive = join(fixtures, archiveName);
    execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
    const archiveBytes = await readFile(archive);
    const checksum = `${createHash("sha256").update(archiveBytes).digest("hex")}  ${archiveName}\n`;
    await writeFile(join(fixtures, `${archiveName}.sha256`), checksum);
    await writeFile(
      join(fixtures, "release.json"),
      JSON.stringify({
        tag_name: "v1.2.0",
        draft: false,
        prerelease: false,
        assets: [
          { name: archiveName, browser_download_url: `https://fixtures/${archiveName}` },
          {
            name: `${archiveName}.sha256`,
            browser_download_url: `https://fixtures/${archiveName}.sha256`,
          },
        ],
      }),
    );

    const fakeCurl = join(fakeBin, "curl");
    await writeFile(
      fakeCurl,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
const url = args.find((value) => value.startsWith("https://"));
const name = url.includes("api.github.com") ? "release.json" : path.basename(url);
fs.copyFileSync(path.join(process.env.TELEX_TEST_FIXTURES, name), output);
`,
      { mode: 0o755 },
    );

    const install = join(root, "install");
    const config = join(root, "config");
    const bin = join(root, "bin");
    execFileSync(
      "sh",
      [
        resolve("scripts/install.sh"),
        "--install-dir",
        install,
        "--config-dir",
        config,
        "--bin-dir",
        bin,
        "--no-service",
      ],
      {
        env: {
          ...process.env,
          HOME: root,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TELEX_TEST_FIXTURES: fixtures,
        },
        stdio: "pipe",
      },
    );

    expect(await readlink(join(install, "current"))).toBe(join("releases", "1.2.0"));
    expect(await readlink(join(bin, "telex"))).toBe(join(install, "bin", "telex"));
    expect(await readFile(join(config, "telex.env"), "utf8")).toContain("TELEX_UPDATE_MODE=auto");
    expect(execFileSync(join(bin, "telex"), ["version"], { encoding: "utf8" }).trim()).toBe(
      "1.2.0",
    );
  });
});
