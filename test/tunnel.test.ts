import { describe, expect, it } from "vitest";
import { extractTryCloudflareUrl } from "../src/miniapp/tunnel.js";

describe("extractTryCloudflareUrl", () => {
  it("finds the URL inside cloudflared's banner box", () => {
    const line =
      "2026-07-19T00:00:00Z INF |  https://lorem-ipsum-dolor-sit.trycloudflare.com                                            |";
    expect(extractTryCloudflareUrl(line)).toBe("https://lorem-ipsum-dolor-sit.trycloudflare.com");
  });

  it("ignores unrelated log lines", () => {
    expect(extractTryCloudflareUrl("INF Starting tunnel connection")).toBeUndefined();
    expect(
      extractTryCloudflareUrl("Visit https://developers.cloudflare.com for docs"),
    ).toBeUndefined();
  });
});
