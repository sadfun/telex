import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const miniAppDirectory = new URL("../src/miniapp/", import.meta.url);

describe("Mini App responsive shell", () => {
  it("loads the source-owned stylesheet instead of Telegram UI's global bundle", async () => {
    const [html, client] = await Promise.all([
      readFile(new URL("index.html", miniAppDirectory), "utf8"),
      readFile(new URL("client.tsx", miniAppDirectory), "utf8"),
    ]);

    expect(html).toContain('href="/miniapp/app.css"');
    expect(html).not.toContain("TELEGRAM_UI_STYLES");
    expect(client).toContain('from "./ui.js"');
    expect(client).not.toContain("@telegram-apps/telegram-ui");
  });

  it("keeps narrow viewports wrapped, safe-area aware, and clear of fixed controls", async () => {
    const styles = await readFile(new URL("styles.css", miniAppDirectory), "utf8");

    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).toContain("word-break: break-word");
    expect(styles).toContain("-webkit-line-clamp: 2");
    expect(styles).toContain("env(safe-area-inset-bottom)");
    expect(styles).toContain(".pageWithSaveDock");
  });

  it("uses Telegram's primary background for the canvas and secondary color for cards", async () => {
    const styles = await readFile(new URL("styles.css", miniAppDirectory), "utf8");

    expect(styles).toContain("--background: var(--tg-theme-bg-color, #ffffff)");
    expect(styles).toContain(
      "--card: var(--tg-theme-secondary-bg-color, var(--tg-theme-bg-color, #f4f4f5))",
    );
    expect(styles).toContain("--tg-theme-section-bg-color");
    expect(styles).toContain("--tg-theme-section-separator-color");
    expect(styles).toContain("--tg-theme-section-header-text-color");
    expect(styles).toContain("--tg-theme-subtitle-text-color");
    expect(styles).toContain("--tg-theme-bottom-bar-bg-color");
    expect(styles).not.toContain("--background: var(--tg-theme-secondary-bg-color, #f4f4f5)");
  });

  it("pairs switch and destructive-action colors without hard-coded foregrounds", async () => {
    const [styles, ui] = await Promise.all([
      readFile(new URL("styles.css", miniAppDirectory), "utf8"),
      readFile(new URL("ui.tsx", miniAppDirectory), "utf8"),
    ]);

    expect(styles).toContain("--switch-thumb: var(--tg-theme-bg-color, var(--primary-foreground))");
    expect(styles).toContain(
      "--destructive-foreground: var(--tg-theme-bg-color, var(--primary-foreground))",
    );
    expect(styles).toContain(".appRoot.dark");
    expect(styles).toContain(
      "--destructive-foreground: var(--tg-theme-text-color, var(--primary-foreground))",
    );
    expect(styles).toContain('.ui-switch[data-state="checked"] .ui-switch-thumb');
    expect(styles).toContain("background: var(--primary-foreground)");
    expect(styles).toContain("color: var(--destructive-foreground)");
    expect(styles).not.toContain("var(--destructive) 88%, black");
    expect(ui).toContain("ui-switch-thumb");
    expect(ui).not.toContain("bg-white");
  });

  it("renders skill Markdown and hides the clean-state save dock", async () => {
    const client = await readFile(new URL("client.tsx", miniAppDirectory), "utf8");

    expect(client).toContain("renderMarkdownPreview(options.skillDocument.content, true)");
    expect(client).toContain("const showSaveDock =");
    expect(client).toContain("showSaveDock");
  });

  it("renders weekly usage and keeps the five-hour window conditional", async () => {
    const [client, styles] = await Promise.all([
      readFile(new URL("client.tsx", miniAppDirectory), "utf8"),
      readFile(new URL("styles.css", miniAppDirectory), "utf8"),
    ]);

    expect(client).toContain('["Weekly", usage.weekly]');
    expect(client).toContain('["5 hours", usage.fiveHour]');
    expect(client).toContain("usage?.fiveHour === null");
    expect(client).toContain('role: "progressbar"');
    expect(styles).toContain(".usageTrack");
    expect(styles).toContain(".usageRemaining-low");
  });

  it("expands banked resets and requires confirmation before applying one", async () => {
    const [client, styles] = await Promise.all([
      readFile(new URL("client.tsx", miniAppDirectory), "utf8"),
      readFile(new URL("styles.css", miniAppDirectory), "utf8"),
    ]);

    expect(client).toContain("banked reset");
    expect(client).toContain('"aria-expanded": expanded');
    expect(client).toContain("Apply this reset");
    expect(client).toContain("Apply banked reset?");
    expect(client).toContain('"aria-modal": "true"');
    expect(client).toContain('requestJson("/api/usage/reset"');
    expect(styles).toContain(".bankedResetsSummary");
    expect(styles).toContain(".resetDialogBackdrop");
  });
});
