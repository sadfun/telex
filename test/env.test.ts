import { describe, expect, it } from "vitest";
import { loadAppConfig, loadUpdateConfig } from "../src/config/env.js";

const required = {
  TELEGRAM_BOT_TOKEN: "12345678901234567890:token",
  TELEGRAM_ALLOWED_USER_IDS: "42, 9001",
};

describe("loadAppConfig", () => {
  it("parses allowlisted users and safe defaults", () => {
    const config = loadAppConfig(required);
    expect([...config.allowedUserIds]).toEqual([42, 9001]);
    expect(config.telegramApiBase).toBe("https://api.telegram.org");
    expect(config.checkCodexUpdates).toBe(true);
    expect(config.updateMode).toBe("notify");
    expect(config.updateIntervalMs).toBe(6 * 60 * 60 * 1_000);
    expect(config.updateRepository).toBe("sadfun/telex");
    expect(config.installDirectory).toBeUndefined();
    expect(config.host).toBe("127.0.0.1");
    expect(config.tunnelMode).toBe("auto");
  });

  it("disables the quick tunnel with TELEX_TUNNEL=off", () => {
    expect(loadAppConfig({ ...required, TELEX_TUNNEL: "off" }).tunnelMode).toBe("off");
  });

  it("parses installer-managed automatic update settings", () => {
    const config = loadAppConfig({
      ...required,
      TELEX_UPDATE_MODE: "auto",
      TELEX_UPDATE_INTERVAL_HOURS: "12",
      TELEX_UPDATE_REPOSITORY: "example/fork",
      TELEX_INSTALL_DIR: "/opt/telex",
    });
    expect(config.updateMode).toBe("auto");
    expect(config.updateIntervalMs).toBe(12 * 60 * 60 * 1_000);
    expect(config.updateRepository).toBe("example/fork");
    expect(config.installDirectory).toBe("/opt/telex");
  });

  it("loads update settings before Telegram credentials are configured", () => {
    expect(loadUpdateConfig({ TELEX_INSTALL_DIR: "/opt/telex" })).toMatchObject({
      updateMode: "notify",
      updateRepository: "sadfun/telex",
      installDirectory: "/opt/telex",
    });
  });

  it("rejects malformed allowlist entries", () => {
    expect(() =>
      loadAppConfig({
        ...required,
        TELEGRAM_ALLOWED_USER_IDS: "42,not-a-user",
      }),
    ).toThrow();
  });
});
