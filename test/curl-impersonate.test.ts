import { describe, expect, it } from "vitest";
import {
  curlImpersonateAssetFor,
  curlImpersonateTarget,
  curlImpersonateVersion,
} from "../src/transcription/curl-impersonate.js";

describe("curl-impersonate toolchain", () => {
  it.each([
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
  ])("has a checksum-pinned %s-%s asset", (platform, arch) => {
    const asset = curlImpersonateAssetFor(platform, arch);
    expect(asset?.name).toContain(`v${curlImpersonateVersion}`);
    expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects unsupported platforms", () => {
    expect(curlImpersonateAssetFor("win32", "x64")).toBeUndefined();
    expect(curlImpersonateAssetFor("linux", "ia32")).toBeUndefined();
  });

  it("pins a browser profile contained in the release", () => {
    expect(curlImpersonateTarget).toBe("chrome146");
  });
});
