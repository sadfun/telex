import type { CodexService } from "../codex/service.js";
import type { LoginAccountResponse } from "../generated/codex/v2/LoginAccountResponse.js";
import { errorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { InboundMessage, MessageHandler } from "./channel.js";

const helpText = [
  "Send me a message to work with Codex in this conversation.",
  "",
  "/new — start a fresh Codex task",
  "/stop — stop the current turn",
  "/status — check Codex and sign-in status",
  "/login — sign in to ChatGPT",
  "/logout — sign out",
  "/config — open Codex settings",
  "/help — show this help",
].join("\n");

interface ParsedCommand {
  readonly name: string;
}

export class CodexBridge {
  readonly #codex: CodexService;
  readonly #publicUrl: string | undefined;
  readonly #logger: Logger;

  public readonly handleMessage: MessageHandler = async (message) => {
    try {
      const command = parseCommand(message.text);
      if (command === undefined) {
        await this.#codex.runTurn(
          message.address.key,
          message.text,
          message.responder,
          message.address.isGuest,
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

  public constructor(codex: CodexService, publicUrl: string | undefined, logger: Logger) {
    this.#codex = codex;
    this.#publicUrl = publicUrl;
    this.#logger = logger;
  }

  private async handleCommand(message: InboundMessage, command: ParsedCommand): Promise<void> {
    switch (command.name) {
      case "start":
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
      case "login":
        if (!(await this.requirePrivateChat(message))) return;
        await this.sendLogin(message, await this.#codex.startDeviceLogin());
        return;
      case "logout":
        if (!(await this.requirePrivateChat(message))) return;
        await this.#codex.logout();
        await message.responder.sendText("Signed out of Codex.");
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
      default:
        await message.responder.sendText(`Unknown command /${command.name}.\n\n${helpText}`);
    }
  }

  private async requirePrivateChat(message: InboundMessage): Promise<boolean> {
    if (message.address.isPrivate && !message.address.isGuest) return true;
    await message.responder.sendText("This command is available in a private bot chat only.");
    return false;
  }

  private async statusText(): Promise<string> {
    const response = await this.#codex.account();
    const account = response.account;
    if (account === null) {
      return response.requiresOpenaiAuth
        ? "Codex app-server is connected. Not signed in; use /login."
        : "Codex app-server is connected. This configuration does not require OpenAI sign-in.";
    }
    switch (account.type) {
      case "apiKey":
        return "Codex app-server is connected. Authentication: OpenAI API key.";
      case "chatgpt":
        return `Codex app-server is connected. Signed in to ChatGPT (${account.planType}).`;
      case "amazonBedrock":
        return "Codex app-server is connected. Authentication: Amazon Bedrock.";
    }
  }

  private async sendLogin(message: InboundMessage, login: LoginAccountResponse): Promise<void> {
    switch (login.type) {
      case "chatgptDeviceCode":
        await message.responder.sendText(
          `Open the sign-in page and enter this one-time code:\n\n${login.userCode}`,
          {
            button: { label: "Open sign-in", kind: "url", url: login.verificationUrl },
          },
        );
        return;
      case "chatgpt":
        await message.responder.sendText("Open the sign-in page to continue.", {
          button: { label: "Open sign-in", kind: "url", url: login.authUrl },
        });
        return;
      case "apiKey":
        await message.responder.sendText("Codex is configured to use an API key.");
        return;
      case "chatgptAuthTokens":
        await message.responder.sendText("Codex is configured with ChatGPT authentication tokens.");
    }
  }
}

function parseCommand(text: string): ParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?(?:\s+[\s\S]*)?$/i.exec(text.trim());
  const name = match?.[1];
  if (name === undefined) return undefined;
  return {
    name: name.toLowerCase(),
  };
}
