import { afterEach, describe, expect, it } from "vitest";
import { externalProcessEnvironment } from "../src/shared/environment.js";

const originalToken = process.env.TELEGRAM_BOT_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
});

describe("externalProcessEnvironment", () => {
  it("does not expose Telegram credentials to Codex or npm", () => {
    process.env.TELEGRAM_BOT_TOKEN = "secret";
    const environment = externalProcessEnvironment({ CODEX_HOME: "/isolated" });
    expect(environment.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(environment.CODEX_HOME).toBe("/isolated");
    expect(environment.PATH).toBe(process.env.PATH);
  });
});
