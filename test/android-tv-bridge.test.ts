import { describe, expect, it, vi } from "vitest";
import type { CodexService } from "../src/codex/service.js";
import { CodexBridge, type DevicePairingCommand } from "../src/core/bridge.js";
import type { InboundMessage } from "../src/core/channel.js";
import { Logger } from "../src/shared/logger.js";

describe("Android TV pairing bridge command", () => {
  it.each([
    [{ name: "pair", args: "12345678" }, "/pair 12345678"],
    [{ name: "start", args: "tv_12345678" }, "/start tv_12345678"],
  ])("approves a private transport command %s", async (command, text) => {
    const approve = vi.fn(async () => ({
      status: "approved" as const,
      device: { id: "tv-1", name: "Living room TV" },
    }));
    const pairing = { approve } as DevicePairingCommand;
    const responder = {
      createStream: vi.fn(),
      sendText: vi.fn(async () => undefined),
      askChoice: vi.fn(async () => ""),
    };
    const bridge = new CodexBridge(
      { onLoginCompleted: vi.fn() } as unknown as CodexService,
      undefined,
      new Logger("error"),
      undefined,
      undefined,
      undefined,
      pairing,
    );
    const message: InboundMessage = {
      id: "telegram-message",
      address: {
        channel: "telegram",
        key: "telegram:42:0",
        isPrivate: true,
        isGuest: false,
      },
      sender: { id: "42", displayName: "Owner" },
      text,
      command,
      attachments: [],
      responder,
    };

    await bridge.handleMessage(message);

    expect(approve).toHaveBeenCalledWith("12345678", {
      provider: "telegram",
      resource: "user",
      id: "42",
    });
    expect(responder.sendText).toHaveBeenCalledWith(
      expect.stringContaining("Paired Living room TV"),
    );
  });

  it("rejects pairing outside a private chat", async () => {
    const approve = vi.fn();
    const responder = {
      createStream: vi.fn(),
      sendText: vi.fn(async () => undefined),
      askChoice: vi.fn(async () => ""),
    };
    const bridge = new CodexBridge(
      { onLoginCompleted: vi.fn() } as unknown as CodexService,
      undefined,
      new Logger("error"),
      undefined,
      undefined,
      undefined,
      { approve } as unknown as DevicePairingCommand,
    );

    await bridge.handleMessage({
      id: "public",
      address: {
        channel: "telegram",
        key: "telegram:42:1",
        isPrivate: false,
        isGuest: false,
      },
      sender: { id: "42", displayName: "Owner" },
      text: "/pair 12345678",
      command: { name: "pair", args: "12345678" },
      attachments: [],
      responder,
    });

    expect(approve).not.toHaveBeenCalled();
    expect(responder.sendText).toHaveBeenCalledWith(
      "This command is available in a private bot chat only.",
    );
  });
});
