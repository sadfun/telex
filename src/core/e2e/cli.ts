import { readFile, stat } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { launchTelegramE2e, runTelegramE2eSuite } from "../../channels/telegram/e2e.js";
import { type CodexE2eToken, launchE2eTelex } from "./instance.js";
import { AdjustableE2eClock, runCoreE2eSuite } from "./suite.js";

const usage = `Usage:
  npm test -- --voice-file PATH --voice-text TEXT [--codex-token-file PATH]
  npm run test:telegram -- --voice-file PATH --voice-text TEXT [options]

Core options:
  --codex-token-file PATH   mode-0600 JSON: accessToken, accountId, optional planType
  --codex-binary PATH       reuse an already installed pinned Codex executable
  --voice-file PATH         real speech recording sent as a voice attachment
  --voice-text TEXT         phrase expected in the real transcription

Telegram options:
  --telex-bot-token-file PATH  mode-0600 Telex test-bot token
  --peer-bot-token-file PATH   mode-0600 bot-to-bot driver token
  --chat-id ID                 optional real group/forum destination
  --thread-ids ID,ID           optional real topics for concurrent-thread coverage

Missing secrets are requested interactively with hidden input. Raw tokens are never accepted
as command-line arguments and are never logged.`;

interface Arguments {
  readonly mode: "core" | "telegram";
  readonly values: ReadonlyMap<string, string>;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    stdout.write(`${usage}\n`);
    return;
  }
  const parsed = parseArguments(process.argv.slice(2));
  const voiceFile = requiredValue(parsed.values, "voice-file", "TELEX_E2E_VOICE_FILE");
  const expectedVoiceText = requiredValue(parsed.values, "voice-text", "TELEX_E2E_VOICE_TEXT");
  await assertReadable(voiceFile);
  const token = await readCodexToken(parsed.values.get("codex-token-file"));
  const requestToken = async (): Promise<CodexE2eToken> => token;
  const codexBinaryPath = parsed.values.get("codex-binary") ?? process.env.TELEX_E2E_CODEX_BINARY;
  const logLevel = process.env.TELEX_E2E_LOG_LEVEL === "debug" ? "debug" : "info";
  const clock = new AdjustableE2eClock();

  if (parsed.mode === "core") {
    const instance = await launchE2eTelex({
      requestToken,
      now: clock.now,
      logLevel,
      ...(codexBinaryPath === undefined ? {} : { codexBinaryPath }),
    });
    try {
      printResults(await runCoreE2eSuite({ instance, clock, voiceFile, expectedVoiceText }));
    } finally {
      await instance.stop();
    }
    return;
  }

  const telexBotToken = await readSecret(
    "Telex test-bot token",
    parsed.values.get("telex-bot-token-file") ?? process.env.TELEX_E2E_TELEX_BOT_TOKEN_FILE,
  );
  const peerBotToken = await readSecret(
    "Bot-to-bot peer token",
    parsed.values.get("peer-bot-token-file") ?? process.env.TELEX_E2E_PEER_BOT_TOKEN_FILE,
  );
  const chatId = optionalInteger(parsed.values.get("chat-id") ?? process.env.TELEX_E2E_CHAT_ID);
  const threadIds = optionalThreadIds(
    parsed.values.get("thread-ids") ?? process.env.TELEX_E2E_THREAD_IDS,
  );
  const instance = await launchTelegramE2e({
    telexBotToken,
    peerBotToken,
    requestToken,
    clock,
    logLevel,
    ...(codexBinaryPath === undefined ? {} : { codexBinaryPath }),
    ...(chatId === undefined ? {} : { chatId }),
    ...(threadIds === undefined ? {} : { threadIds }),
  });
  try {
    printResults(await runTelegramE2eSuite({ instance, clock, voiceFile, expectedVoiceText }));
  } finally {
    await instance.stop();
  }
}

function parseArguments(argumentsValue: readonly string[]): Arguments {
  let mode: Arguments["mode"] = process.env.TELEX_E2E_MODE === "telegram" ? "telegram" : "core";
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    if (argument === "core" || argument === "telegram") {
      mode = argument;
      continue;
    }
    if (argument?.startsWith("--") !== true) throw new Error(`Unknown argument: ${argument}`);
    const value = argumentsValue[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    values.set(argument.slice(2), value);
    index += 1;
  }
  return { mode, values };
}

async function readCodexToken(path: string | undefined): Promise<CodexE2eToken> {
  const resolvedPath = path ?? process.env.TELEX_E2E_CODEX_TOKEN_FILE;
  if (resolvedPath !== undefined) {
    const parsed = JSON.parse(await readMode600(resolvedPath)) as Partial<CodexE2eToken>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.accountId !== "string") {
      throw new Error("Codex token JSON requires accessToken and accountId strings");
    }
    return {
      accessToken: parsed.accessToken,
      accountId: parsed.accountId,
      ...(parsed.planType === undefined ? {} : { planType: parsed.planType }),
    };
  }
  if (!stdin.isTTY) throw new Error("Provide TELEX_E2E_CODEX_TOKEN_FILE for non-interactive runs");
  const accessToken = await hiddenPrompt("Codex-provided ChatGPT access token: ");
  const accountId = await visiblePrompt("ChatGPT account/workspace ID: ");
  const planType = await visiblePrompt("ChatGPT plan type (optional): ");
  return { accessToken, accountId, ...(planType.length === 0 ? {} : { planType }) };
}

async function readSecret(label: string, path: string | undefined): Promise<string> {
  if (path !== undefined) return (await readMode600(path)).trim();
  if (!stdin.isTTY) throw new Error(`Provide a mode-0600 token file for ${label}`);
  return await hiddenPrompt(`${label}: `);
}

async function readMode600(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`Secret file must be a regular mode-0600 file: ${path}`);
  }
  return await readFile(path, "utf8");
}

async function hiddenPrompt(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Hidden token input requires an interactive terminal");
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    for await (const chunk of stdin) {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          stdout.write("\n");
          if (value.length === 0) throw new Error("Token cannot be empty");
          return value;
        }
        if (character === "\u0003") throw new Error("Token input cancelled");
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  throw new Error("Token input ended unexpectedly");
}

async function visiblePrompt(prompt: string): Promise<string> {
  const input = createInterface({ input: stdin, output: stdout });
  try {
    return (await input.question(prompt)).trim();
  } finally {
    input.close();
  }
}

function requiredValue(
  values: ReadonlyMap<string, string>,
  name: string,
  environment: string,
): string {
  const value = values.get(name) ?? process.env[environment];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing --${name} (or ${environment})`);
  }
  return value;
}

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Expected an integer, received ${value}`);
  return parsed;
}

function optionalThreadIds(value: string | undefined): readonly [number, number] | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",").map((part) => optionalInteger(part.trim()));
  if (values.length !== 2 || values[0] === undefined || values[1] === undefined) {
    throw new Error("--thread-ids requires two comma-separated integers");
  }
  return [values[0], values[1]];
}

async function assertReadable(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`Voice fixture is empty: ${path}`);
}

function printResults(results: readonly { name: string; durationMs: number }[]): void {
  for (const result of results) stdout.write(`PASS ${result.name} (${result.durationMs} ms)\n`);
  stdout.write(`E2E PASS: ${results.length} real-system scenarios\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
