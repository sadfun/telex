import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The theme variables Telegram injects into Mini App webviews. Styling may
 * only rely on these exact names; a typo would silently fall back to the
 * hard-coded defaults and break theming.
 */
const telegramThemeVariables = new Set([
  "--tg-theme-accent-text-color",
  "--tg-theme-bg-color",
  "--tg-theme-bottom-bar-bg-color",
  "--tg-theme-button-color",
  "--tg-theme-button-text-color",
  "--tg-theme-destructive-text-color",
  "--tg-theme-header-bg-color",
  "--tg-theme-hint-color",
  "--tg-theme-link-color",
  "--tg-theme-secondary-bg-color",
  "--tg-theme-section-bg-color",
  "--tg-theme-section-header-text-color",
  "--tg-theme-section-separator-color",
  "--tg-theme-subtitle-text-color",
  "--tg-theme-text-color",
]);

describe("Mini App Telegram theme contract", () => {
  it("references only theme variables Telegram actually injects", async () => {
    const styles = await readFile(new URL("../src/miniapp/styles.css", import.meta.url), "utf8");
    const used = [...new Set(styles.match(/--tg-theme-[a-z-]+/g) ?? [])];
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !telegramThemeVariables.has(name))).toEqual([]);
  });
});
