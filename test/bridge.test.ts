import { describe, expect, it, vi } from "vitest";
import type { CodexService } from "../src/codex/service.js";
import {
  CodexBridge,
  type CodexRuntimeCommand,
  type TelexUpdateCommand,
  type TelexUpdateResult,
} from "../src/core/bridge.js";
import type {
  InboundAttachment,
  InboundCommand,
  InboundMessage,
  SendOptions,
} from "../src/core/channel.js";
import type { AccountLoginCompletedNotification } from "../src/generated/codex/v2/AccountLoginCompletedNotification.js";
import type { GetAccountResponse } from "../src/generated/codex/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "../src/generated/codex/v2/LoginAccountResponse.js";
import { Logger } from "../src/shared/logger.js";

const logger = new Logger("error");

function createResponder() {
  return {
    createStream: vi.fn(),
    sendText: vi.fn(async (_text: string, _options?: SendOptions) => undefined),
    askChoice: vi.fn(async () => "decline"),
  };
}

function createMessage(
  text: string,
  responder: ReturnType<typeof createResponder>,
  address: Partial<InboundMessage["address"]> = {},
  attachments: readonly InboundAttachment[] = [],
  command?: InboundCommand,
): InboundMessage {
  return {
    id: "1",
    address: {
      channel: "telegram",
      key: "telegram:1:0",
      isPrivate: true,
      isGuest: false,
      ...address,
    },
    sender: { id: "1", displayName: "Test" },
    text,
    ...(command === undefined ? {} : { command }),
    attachments,
    responder,
  };
}

function createCodex(overrides: Record<string, unknown> = {}) {
  let loginListener: ((notification: AccountLoginCompletedNotification) => void) | undefined;
  const raw = {
    runTurn: vi.fn(async () => undefined),
    resetConversation: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => false),
    account: vi.fn(
      async (): Promise<GetAccountResponse> => ({ account: null, requiresOpenaiAuth: true }),
    ),
    startDeviceLogin: vi.fn(
      async (): Promise<LoginAccountResponse> => ({
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://example.com/device",
        userCode: "ABCD-1234",
      }),
    ),
    logout: vi.fn(async () => undefined),
    onLoginCompleted: vi.fn((listener: (n: AccountLoginCompletedNotification) => void) => {
      loginListener = listener;
    }),
    ...overrides,
  };
  return {
    raw,
    codex: raw as unknown as CodexService,
    emitLoginCompleted: (notification: AccountLoginCompletedNotification) => {
      loginListener?.(notification);
    },
  };
}

const signedInAccount: GetAccountResponse = {
  account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
  requiresOpenaiAuth: true,
};

describe("CodexBridge onboarding", () => {
  it("welcomes a signed-in user on /start without starting a login", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/start", responder));

    expect(raw.startDeviceLogin).not.toHaveBeenCalled();
    const text = responder.sendText.mock.calls[0]?.[0];
    expect(text).toContain("signed in to ChatGPT (plus)");
    expect(text).toContain("ready to go");
  });

  it.each(["/start payload", "/start@telex_bot payload"])(
    "accepts Telegram's start payload syntax: %s",
    async (text) => {
      const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
      const bridge = new CodexBridge(codex, undefined, logger);
      const responder = createResponder();

      await bridge.handleMessage(createMessage(text, responder));

      expect(raw.runTurn).not.toHaveBeenCalled();
      expect(responder.sendText.mock.calls[0]?.[0]).toContain("ready to go");
    },
  );

  it("prefers a transport command over normalized reply context and attachments", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();

    await bridge.handleMessage(
      createMessage(
        "Replying to Topic:\n  [Photo]\n/start",
        responder,
        {},
        [{ kind: "image", path: "/workspace/topic.jpg", description: "Topic root" }],
        { name: "start", args: "" },
      ),
    );

    expect(raw.runTurn).not.toHaveBeenCalled();
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("ready to go");
  });

  it("starts the sign-in flow directly from /start in a private chat", async () => {
    const { codex, raw } = createCodex();
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/start", responder));

    expect(raw.startDeviceLogin).toHaveBeenCalledTimes(1);
    const call = responder.sendText.mock.calls[0];
    expect(call?.[0]).toContain("ABCD-1234");
    expect(call?.[0]).toContain("I'll confirm here");
    expect(call?.[1]?.button?.url).toBe("https://example.com/device");
  });

  it("points group members to a private chat on /start when sign-in is needed", async () => {
    const { codex, raw } = createCodex();
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/start", responder, { isPrivate: false }));

    expect(raw.startDeviceLogin).not.toHaveBeenCalled();
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("open a private chat");
  });

  it("intercepts a task message when not signed in and resumes it after login", async () => {
    const { codex, raw, emitLoginCompleted } = createCodex();
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    const attachments: readonly InboundAttachment[] = [
      { kind: "image", path: "/workspace/photo.jpg", description: "Telegram photo" },
    ];
    await bridge.handleMessage(createMessage("fix the tests", responder, {}, attachments));

    expect(raw.runTurn).not.toHaveBeenCalled();
    expect(raw.startDeviceLogin).toHaveBeenCalledTimes(1);
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("ABCD-1234");

    raw.account.mockResolvedValue(signedInAccount);
    emitLoginCompleted({ loginId: "login-1", success: true, error: null });
    await vi.waitFor(() => {
      expect(raw.runTurn).toHaveBeenCalledWith(
        "telegram:1:0",
        "telegram",
        "fix the tests",
        responder,
        false,
        attachments,
      );
    });
    const confirmation = responder.sendText.mock.calls[1]?.[0];
    expect(confirmation).toContain("✅");
    expect(confirmation).toContain("starting on your message");
  });

  it("confirms sign-in after /login completes", async () => {
    const { codex, emitLoginCompleted } = createCodex();
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/login", responder));

    emitLoginCompleted({ loginId: "login-1", success: true, error: null });
    await vi.waitFor(() => {
      expect(responder.sendText).toHaveBeenCalledTimes(2);
    });
    expect(responder.sendText.mock.calls[1]?.[0]).toContain("✅");
  });

  it("reports a failed sign-in", async () => {
    const { codex, emitLoginCompleted } = createCodex();
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/login", responder));

    emitLoginCompleted({ loginId: "login-1", success: false, error: "code expired" });
    await vi.waitFor(() => {
      expect(responder.sendText).toHaveBeenCalledTimes(2);
    });
    const text = responder.sendText.mock.calls[1]?.[0];
    expect(text).toContain("code expired");
    expect(text).toContain("/login");
  });

  it("skips repeated account checks once sign-in is confirmed", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("task one", responder));
    await bridge.handleMessage(createMessage("task two", responder));

    expect(raw.runTurn).toHaveBeenCalledTimes(2);
    expect(raw.account).toHaveBeenCalledTimes(1);
  });

  it("passes the current connector to Codex", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();

    await bridge.handleMessage(
      createMessage("summarize this", responder, {
        channel: "discord",
        key: "discord:1",
      }),
    );

    expect(raw.runTurn).toHaveBeenCalledWith(
      "discord:1",
      "discord",
      "summarize this",
      responder,
      false,
      [],
    );
  });

  it("does not treat a media caption that starts with a command as a command", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    const attachments: readonly InboundAttachment[] = [
      { kind: "image", path: "/workspace/photo.jpg", description: "Telegram photo" },
    ];

    await bridge.handleMessage(createMessage("/new\n[Photo]", responder, {}, attachments));

    expect(raw.resetConversation).not.toHaveBeenCalled();
    expect(raw.runTurn).toHaveBeenCalledWith(
      "telegram:1:0",
      "telegram",
      "/new\n[Photo]",
      responder,
      false,
      attachments,
    );
  });

  it("does not treat a voice-message caption as a command", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    const attachments: readonly InboundAttachment[] = [
      {
        kind: "voice",
        path: "/workspace/voice.ogg",
        description: "Telegram voice message",
      },
    ];

    await bridge.handleMessage(createMessage("/new", responder, {}, attachments));

    expect(raw.resetConversation).not.toHaveBeenCalled();
    expect(raw.runTurn).toHaveBeenCalledWith(
      "telegram:1:0",
      "telegram",
      "/new",
      responder,
      false,
      attachments,
    );
  });

  it("tells an already signed-in user how to switch accounts on /login", async () => {
    const { codex, raw } = createCodex({ account: vi.fn(async () => signedInAccount) });
    const bridge = new CodexBridge(codex, undefined, logger);
    const responder = createResponder();
    await bridge.handleMessage(createMessage("/login", responder));

    expect(raw.startDeviceLogin).not.toHaveBeenCalled();
    const text = responder.sendText.mock.calls[0]?.[0];
    expect(text).toContain("already signed in to ChatGPT (plus)");
    expect(text).toContain("/logout");
  });
});

describe("CodexBridge updates", () => {
  it("reports when Telex is already current", async () => {
    const { codex } = createCodex();
    const updateCommand: TelexUpdateCommand = {
      canInstall: true,
      run: vi.fn(async (): Promise<TelexUpdateResult> => ({ status: "current", version: "1.2.3" })),
      onInstalled: vi.fn(),
    };
    const bridge = new CodexBridge(codex, undefined, logger, updateCommand);
    const responder = createResponder();

    await bridge.handleMessage(createMessage("/update", responder));

    expect(updateCommand.run).toHaveBeenCalledTimes(1);
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("Checking");
    expect(responder.sendText.mock.calls[1]?.[0]).toContain("1.2.3 is already current");
    expect(updateCommand.onInstalled).not.toHaveBeenCalled();
  });

  it("installs the latest release and requests a restart", async () => {
    const { codex } = createCodex();
    const updateCommand: TelexUpdateCommand = {
      canInstall: true,
      run: vi.fn(
        async (): Promise<TelexUpdateResult> => ({
          status: "installed",
          previousVersion: "1.2.3",
          version: "1.3.0",
        }),
      ),
      onInstalled: vi.fn(),
    };
    const bridge = new CodexBridge(codex, undefined, logger, updateCommand);
    const responder = createResponder();

    await bridge.handleMessage(createMessage("/update", responder));

    expect(responder.sendText.mock.calls[1]?.[0]).toContain("Installed Telex 1.3.0");
    expect(responder.sendText.mock.calls[1]?.[0]).toContain("Restarting");
    expect(updateCommand.onInstalled).toHaveBeenCalledWith("1.3.0");
  });

  it("explains that source checkouts must be updated with Git", async () => {
    const { codex } = createCodex();
    const updateCommand: TelexUpdateCommand = {
      canInstall: false,
      run: vi.fn(),
      onInstalled: vi.fn(),
    };
    const bridge = new CodexBridge(codex, undefined, logger, updateCommand);
    const responder = createResponder();

    await bridge.handleMessage(createMessage("/update", responder));

    expect(updateCommand.run).not.toHaveBeenCalled();
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("source checkout");
  });
});

describe("CodexBridge runtime controls", () => {
  it.each(["reload", "restart"] as const)("runs /%s in a private chat", async (action) => {
    const { codex } = createCodex();
    const runtime: CodexRuntimeCommand = {
      status: () => ({ state: "ready" }),
      reload: vi.fn(async () => ({ state: "ready" })),
      restart: vi.fn(async () => ({ state: "ready" })),
    };
    const bridge = new CodexBridge(codex, undefined, logger, undefined, runtime);
    const responder = createResponder();

    await bridge.handleMessage(createMessage(`/${action}`, responder));

    expect(runtime[action]).toHaveBeenCalledOnce();
    expect(responder.sendText).toHaveBeenCalledTimes(2);
    expect(responder.sendText.mock.calls[1]?.[0]).toContain("✅");
  });

  it("keeps restart controls out of group chats", async () => {
    const { codex } = createCodex();
    const runtime: CodexRuntimeCommand = {
      status: () => ({ state: "ready" }),
      reload: vi.fn(),
      restart: vi.fn(),
    };
    const bridge = new CodexBridge(codex, undefined, logger, undefined, runtime);
    const responder = createResponder();

    await bridge.handleMessage(createMessage("/restart", responder, { isPrivate: false }));

    expect(runtime.restart).not.toHaveBeenCalled();
    expect(responder.sendText.mock.calls[0]?.[0]).toContain("private bot chat");
  });

  it("points status checks to restart when the app-server is down", async () => {
    const { codex } = createCodex({
      account: vi.fn(async () => Promise.reject(new Error("down"))),
    });
    const runtime: CodexRuntimeCommand = {
      status: () => ({ state: "degraded", lastError: "transport exited" }),
      reload: vi.fn(),
      restart: vi.fn(),
    };
    const bridge = new CodexBridge(codex, undefined, logger, undefined, runtime);
    const responder = createResponder();

    await bridge.handleMessage(createMessage("/status", responder));

    expect(responder.sendText.mock.calls[0]?.[0]).toContain("/restart");
  });
});
