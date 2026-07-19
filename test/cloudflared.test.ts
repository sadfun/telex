import { describe, expect, it } from "vitest";
import { cloudflaredAssetFor, cloudflaredVersion } from "../src/miniapp/cloudflared.js";

describe("cloudflaredAssetFor", () => {
  it("maps supported platforms to pinned assets", () => {
    expect(cloudflaredAssetFor("darwin", "arm64")).toMatchObject({
      name: "cloudflared-darwin-arm64.tgz",
      archive: "tgz",
    });
    expect(cloudflaredAssetFor("linux", "x64")).toMatchObject({
      name: "cloudflared-linux-amd64",
      archive: "binary",
    });
    expect(cloudflaredAssetFor("linux", "arm")).toMatchObject({
      name: "cloudflared-linux-armhf",
    });
  });

  it("returns undefined for unsupported platforms", () => {
    expect(cloudflaredAssetFor("win32", "x64")).toBeUndefined();
    expect(cloudflaredAssetFor("freebsd", "x64")).toBeUndefined();
  });

  it("pins full SHA-256 checksums for every asset", () => {
    expect(cloudflaredVersion).toMatch(/^\d{4}\.\d+\.\d+$/);
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["linux", "arm"],
      ["linux", "ia32"],
    ] as const) {
      expect(cloudflaredAssetFor(platform, arch)?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
