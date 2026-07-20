import type { CodexService } from "../codex/service.js";
import type { Account } from "../generated/codex/v2/Account.js";
import type { AccountLoginCompletedNotification } from "../generated/codex/v2/AccountLoginCompletedNotification.js";
import type { GetAccountResponse } from "../generated/codex/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "../generated/codex/v2/LoginAccountResponse.js";
import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { InboundMessage, MessageHandler, MessageResponder } from "./channel.js";

const introText =
  "👋 Hi, I'm Telex. Send me a message and I'll hand it to Codex, then stream progress and results back into this chat.";

const helpText = [
  "Send me a message to work with Codex in this conversation.",
  "",
  "/new — start a fresh Codex task",
  "/stop — stop the current turn",
  "/status — check Codex and sign-in status",
  "/login — sign in to ChatGPT",
  "/logout — sign out",
  "/config — open Codex settings",
  "/update — update Telex to the latest release",
  "/help — show this help",
].join("\n");

const readyText =
  'Try something like "explain what this project does", or send /help for all commands.';

const loginCodeTtl = 15 * 60 * 1_000;

interface ParsedCommand {
  readonly name: string;
}

export type TelexUpdateResult =
  | { readonly status: "current"; readonly version: string }
  | {
      readonly status: "installed";
      readonly previousVersion: string;
      readonly version: string;
    };

export interface TelexUpdateCommand {
  readonly canInstall: boolean;
  readonly run: () => Promise<TelexUpdateResult>;
  readonly onInstalled: (version: string) => void;
}

interface PendingLogin {
  readonly responder: MessageResponder;
  readonly timer: NodeJS.Timeout;
  /** Message that arrived before sign-in; replayed once login completes. */
  readonly resume?: InboundMessage;
}

export class CodexBridge {
  readonly #codex: CodexService;
  readonly #publicUrl: string | undefined;
  readonly #logger: Logger;
  readonly #updateCommand: TelexUpdateCommand | undefined;
  readonly #pendingLogins = new Map<string, PendingLogin>();
  #signedInConfirmed = false;
  #updateInProgress = false;

  public readonly handleMessage: MessageHandler = async (message) => {
    try {
      const command = parseCommand(message.text);
      if (command === undefined) {
        if (!(await this.ensureSignedIn(message))) return;
        await this.#codex.runTurn(
          message.address.key,
          message.text,
          message.responder,
          message.address.isGuest,
          message.attachments,
        );
        return;
      }
      await this.handleCommand(message, command);
    } catch (error) {
      this.#logger.error("Bridge command failed", error, {
        channel: message.address.channel,
        conversation: message.address.key,
      });
      await message.responder.sendText(`Codex error: ${errorMessage(error)}`);
    }
  };

  public constructor(
    codex: CodexService,
    publicUrl: string | undefined,
    logger: Logger,
    updateCommand?: TelexUpdateCommand,
  ) {
    this.#codex = codex;
    this.#publicUrl = publicUrl;
    this.#logger = logger;
    this.#updateCommand = updateCommand;
    codex.onLoginCompleted((notification) => {
      void this.handleLoginCompleted(notification);
    });
  }

  private async handleCommand(message: InboundMessage, command: ParsedCommand): Promise<void> {
    switch (command.name) {
      case "start":
        await this.handleStart(message);
        return;
      case "help":
        await message.responder.sendText(helpText);
        return;
      case "new":
        await this.#codex.resetConversation(message.address.key);
        await message.responder.sendText("Started a fresh Codex task. What should we work on?");
        return;
      case "stop": {
        const stopped = await this.#codex.interrupt(message.address.key);
        await message.responder.sendText(
          stopped ? "Stopping the current turn." : "Nothing is running.",
        );
        return;
      }
      case "status":
        await message.responder.sendText(await this.statusText());
        return;
      case "login": {
        if (!(await this.requirePrivateChat(message))) return;
        const account = (await this.#codex.account().catch(() => undefined))?.account;
        if (account !== undefined && account !== null) {
          await message.responder.sendText(
            `You're already ${accountSummary(account)}. Send /logout first if you want to switch accounts.`,
          );
          return;
        }
        await this.sendLogin(message.responder, await this.#codex.startDeviceLogin());
        return;
      }
      case "logout":
        if (!(await this.requirePrivateChat(message))) return;
        await this.#codex.logout();
        this.#signedInConfirmed = false;
        await message.responder.sendText(
          "Signed out of Codex. Send /login whenever you want back in.",
        );
        return;
      case "config":
        if (!(await this.requirePrivateChat(message))) return;
        if (this.#publicUrl === undefined) {
          await message.responder.sendText(
            "The settings Mini App is disabled. Set PUBLIC_URL to its public HTTPS origin, or leave TELEX_TUNNEL=auto and restart with network access for an automatic quick tunnel.",
          );
          return;
        }
        await message.responder.sendText("Open the Mini App to edit Codex settings.", {
          button: {
            label: "Open settings",
            kind: "webApp",
            url: `${this.#publicUrl}/miniapp`,
          },
        });
        return;
      case "update":
        await this.handleUpdate(message);
        return;
      default:
        await message.responder.sendText(`Unknown command /${command.name}.\n\n${helpText}`);
    }
  }

  private async handleUpdate(message: InboundMessage): Promise<void> {
    const updateCommand = this.#updateCommand;
    if (updateCommand === undefined || !updateCommand.canInstall) {
      await message.responder.sendText(
        "In-app updates require an installer-managed Telex release. This is a source checkout; update it with Git instead.",
      );
      return;
    }
    if (this.#updateInProgress) {
      await message.responder.sendText("A Telex update is already in progress.");
      return;
    }

    this.#updateInProgress = true;
    try {
      await message.responder.sendText("Checking for the latest Telex release…");
      const result = await updateCommand.run();
      if (result.status === "current") {
        await message.responder.sendText(`Telex ${result.version} is already current.`);
        return;
      }
      try {
        await message.responder.sendText(
          `✅ Installed Telex ${result.version} (previously ${result.previousVersion}). Restarting now…`,
        );
      } finally {
        updateCommand.onInstalled(result.version);
      }
    } catch (error) {
      this.#logger.warn("Manual Telex update failed", { error: errorMessage(error) });
      await message.responder.sendText(`Could not update Telex: ${errorMessage(error)}`);
    } finally {
      this.#updateInProgress = false;
    }
  }

  private async handleStart(message: InboundMessage): Promise<void> {
    const status = await this.#codex.account().catch(() => undefined);
    if (status === undefined) {
      await message.responder.sendText(`${introText}\n\n${helpText}`);
      return;
    }
    if (!needsLogin(status)) {
      const account = status.account;
      const readyLine =
        account === null
          ? "✅ No sign-in needed with this configuration — you're ready to go."
          : `✅ You're ${accountSummary(account)} — ready to go.`;
      await message.responder.sendText(`${introText}\n\n${readyLine}\n\n${readyText}`);
      return;
    }
    if (!isPrivate(message)) {
      await message.responder.sendText(
        `${introText}\n\nTo get set up, open a private chat with me and send /start — I'll walk you through signing in to ChatGPT.`,
      );
      return;
    }
    await this.sendLogin(
      message.responder,
      await this.#codex.startDeviceLogin(),
      `${introText}\n\nOne thing first: let's connect your ChatGPT account.`,
    );
  }

  private async ensureSignedIn(message: InboundMessage): Promise<boolean> {
    if (this.#signedInConfirmed) return true;
    const status = await this.#codex.account().catch(() => undefined);
    // If the status check itself fails, run the turn anyway so the real error surfaces.
    if (status === undefined) return true;
    if (!needsLogin(status)) {
      this.#signedInConfirmed = true;
      return true;
    }
    if (isPrivate(message)) {
      await this.sendLogin(
        message.responder,
        await this.#codex.startDeviceLogin(),
        "Almost there — I need you to sign in to ChatGPT before I can work on that. I'll start on your message as soon as you're in.",
        message,
      );
    } else {
      await message.responder.sendText(
        "Codex isn't signed in yet. Open a private chat with me and send /start to set it up.",
      );
    }
    return false;
  }

  private async handleLoginCompleted(
    notification: AccountLoginCompletedNotification,
  ): Promise<void> {
    if (notification.success) this.#signedInConfirmed = true;
    const pendingLogins = this.takePendingLogins(notification.loginId);
    for (const pending of pendingLogins) {
      try {
        if (notification.success) {
          const account = (await this.#codex.account().catch(() => undefined))?.account;
          const summary =
            account === undefined || account === null ? "signed in" : accountSummary(account);
          const next =
            pending.resume === undefined
              ? "All set — send me a message and I'll get to work."
              : "All set — starting on your message now.";
          await pending.responder.sendText(`✅ You're ${summary}. ${next}`);
          if (pending.resume !== undefined) {
            const resume = pending.resume;
            await this.#codex.runTurn(
              resume.address.key,
              resume.text,
              resume.responder,
              resume.address.isGuest,
              resume.attachments,
            );
          }
        } else {
          await pending.responder.sendText(
            `Sign-in didn't go through${
              notification.error === null ? "" : `: ${notification.error}`
            }. Send /login to try again with a fresh code.`,
          );
        }
      } catch (error) {
        this.#logger.error("Could not deliver sign-in confirmation", error);
      }
    }
  }

  private async sendLogin(
    responder: MessageResponder,
    login: LoginAccountResponse,
    intro?: string,
    resume?: InboundMessage,
  ): Promise<void> {
    const prefix = intro === undefined ? "" : `${intro}\n\n`;
    switch (login.type) {
      case "chatgptDeviceCode":
        this.registerPendingLogin(login.loginId, responder, resume);
        await responder.sendText(
          `${prefix}Tap the button below and enter this one-time code on the sign-in page:\n\n${login.userCode}\n\nI'll confirm here the moment you're in.`,
          {
            button: { label: "Open sign-in", kind: "url", url: login.verificationUrl },
          },
        );
        return;
      case "chatgpt":
        this.registerPendingLogin(login.loginId, responder, resume);
        await responder.sendText(
          `${prefix}Open the sign-in page to continue. I'll confirm here the moment you're in.`,
          {
            button: { label: "Open sign-in", kind: "url", url: login.authUrl },
          },
        );
        return;
      case "apiKey":
        await responder.sendText("Codex is configured to use an API key.");
        return;
      case "chatgptAuthTokens":
        await responder.sendText("Codex is configured with ChatGPT authentication tokens.");
    }
  }

  private registerPendingLogin(
    loginId: string,
    responder: MessageResponder,
    resume?: InboundMessage,
  ): void {
    const existing = this.#pendingLogins.get(loginId);
    if (existing !== undefined) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.#pendingLogins.delete(loginId), loginCodeTtl);
    timer.unref();
    this.#pendingLogins.set(loginId, {
      responder,
      timer,
      ...(resume === undefined ? {} : { resume }),
    });
  }

  private takePendingLogins(loginId: string | null): readonly PendingLogin[] {
    const taken: PendingLogin[] = [];
    for (const [id, pending] of this.#pendingLogins) {
      if (loginId !== null && id !== loginId) continue;
      clearTimeout(pending.timer);
      this.#pendingLogins.delete(id);
      taken.push(pending);
    }
    return taken;
  }

  private async requirePrivateChat(message: InboundMessage): Promise<boolean> {
    if (isPrivate(message)) return true;
    await message.responder.sendText("This command is available in a private bot chat only.");
    return false;
  }

  private async statusText(): Promise<string> {
    const response = await this.#codex.account();
    const account = response.account;
    if (account === null) {
      return response.requiresOpenaiAuth
        ? "Codex app-server is connected. Not signed in — send /login to connect ChatGPT."
        : "Codex app-server is connected. This configuration does not require OpenAI sign-in.";
    }
    return `Codex app-server is connected. You're ${accountSummary(account)}.`;
  }
}

function accountSummary(account: Account): string {
  switch (account.type) {
    case "apiKey":
      return "authenticated with an OpenAI API key";
    case "chatgpt":
      return `signed in to ChatGPT (${account.planType})`;
    case "amazonBedrock":
      return "authenticated through Amazon Bedrock";
  }
}

function needsLogin(status: GetAccountResponse): boolean {
  return status.account === null && status.requiresOpenaiAuth;
}

function isPrivate(message: InboundMessage): boolean {
  return message.address.isPrivate && !message.address.isGuest;
}

function parseCommand(text: string): ParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?$/i.exec(text.trim());
  const name = match?.[1];
  if (name === undefined) return undefined;
  return {
    name: name.toLowerCase(),
  };
}
