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

  it("renders skill Markdown and hides the clean-state save dock", async () => {
    const client = await readFile(new URL("client.tsx", miniAppDirectory), "utf8");

    expect(client).toContain("renderMarkdownPreview(options.skillDocument.content, true)");
    expect(client).toContain("const showSaveDock =");
    expect(client).toContain("showSaveDock");
  });
});
