import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTelegramInitData } from "../src/miniapp/auth.js";

const token = "123456:abcdefghijklmnopqrstuvwxyzABCDE";
const now = new Date("2026-07-19T12:00:00.000Z");

function signedInitData(overrides: Readonly<Record<string, string>> = {}): string {
  const fields = new Map<string, string>([
    ["auth_date", String(Math.floor(now.getTime() / 1_000))],
    ["query_id", "AAEAAAE"],
    ["user", JSON.stringify({ id: 42, first_name: "Ada" })],
    ...Object.entries(overrides),
  ]);
  const dataCheckString = [...fields.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams([...fields, ["hash", hash]]).toString();
}

describe("validateTelegramInitData", () => {
  it("accepts fresh signed data for an allowlisted user", () => {
    const session = validateTelegramInitData(signedInitData(), {
      botToken: token,
      allowedUserIds: new Set([42]),
      now,
    });
    expect(session.user).toMatchObject({ id: 42, first_name: "Ada" });
    expect(session.queryId).toBe("AAEAAAE");
  });

  it("rejects tampering and non-allowlisted users", () => {
    const tampered = signedInitData().replace("Ada", "Eve");
    expect(() =>
      validateTelegramInitData(tampered, {
        botToken: token,
        allowedUserIds: new Set([42]),
        now,
      }),
    ).toThrow(/signature/);
    expect(() =>
      validateTelegramInitData(signedInitData(), {
        botToken: token,
        allowedUserIds: new Set([7]),
        now,
      }),
    ).toThrow(/not allowed/);
  });

  it("rejects expired authentication data", () => {
    expect(() =>
      validateTelegramInitData(
        signedInitData({ auth_date: String(Math.floor(now.getTime() / 1_000) - 3_601) }),
        {
          botToken: token,
          allowedUserIds: new Set([42]),
          now,
        },
      ),
    ).toThrow(/Expired/);
  });
});
