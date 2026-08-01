import type { ProviderReference } from "../channel.js";
import type { E2eTelexInstance } from "./instance.js";
import type { E2eCapturedAttachment, E2eExchange, ProtocolE2eChannel } from "./protocol-channel.js";
import type { E2eTrace, E2eTraceEntry } from "./trace.js";

export interface E2eScenarioResult {
  readonly name: string;
  readonly durationMs: number;
  readonly trace: readonly E2eTraceEntry[];
}

export class AdjustableE2eClock {
  #milliseconds: number;

  public constructor(initial = new Date("2032-01-01T00:00:00.000Z")) {
    this.#milliseconds = initial.getTime();
  }

  public readonly now = (): Date => new Date(this.#milliseconds);

  public advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("E2E clock advances must be finite and non-negative");
    }
    this.#milliseconds += milliseconds;
  }
}

export interface CoreE2eSuiteOptions {
  readonly instance: E2eTelexInstance;
  readonly clock: AdjustableE2eClock;
  readonly voiceFile: string;
  readonly expectedVoiceText: string;
}

export async function runCoreE2eSuite(
  options: CoreE2eSuiteOptions,
): Promise<readonly E2eScenarioResult[]> {
  const channel = requireProtocolChannel(options.instance.protocol);
  const results: E2eScenarioResult[] = [];
  await scenario(results, options.instance.trace, "text round trip", async () => {
    const reply = await channel.send({
      text: "Reply with exactly TELEX_TEXT_E2E_OK and nothing else.",
    });
    expectMarker(reply, "TELEX_TEXT_E2E_OK");
  });

  await scenario(results, options.instance.trace, "voice transcription round trip", async () => {
    const reply = await channel.send({
      conversation: "voice",
      text: `Reply with exactly TELEX_VOICE_E2E_OK only if the voice transcript contains this phrase: ${options.expectedVoiceText}`,
      attachments: [
        {
          kind: "voice",
          path: options.voiceFile,
          description: "operator-provided E2E voice recording",
        },
      ],
    });
    if (!reply.progress.some((progress) => progress.summary === "Transcribing…")) {
      throw new Error("Telex did not expose the real transcription stage");
    }
    expectMarker(reply, "TELEX_VOICE_E2E_OK");
  });

  await scenario(results, options.instance.trace, "generated image attachment", async () => {
    const reply = await channel.send({
      conversation: "image",
      text: "Use the image generation tool to create a simple square red circle on a white background. Then say TELEX_IMAGE_E2E_OK.",
    });
    expectMarker(reply, "TELEX_IMAGE_E2E_OK");
    if (reply.attachments.length === 0) throw new Error("Codex generated no image attachment");
    if (!isImage(reply.attachments[0])) {
      throw new Error("The generated attachment is not a recognized image file");
    }
  });

  await scenario(results, options.instance.trace, "parallel conversation isolation", async () => {
    const [alpha, beta] = await Promise.all([
      channel.send({
        conversation: "parallel-alpha",
        text: "Wait briefly, then reply with exactly TELEX_ALPHA_E2E_OK.",
      }),
      channel.send({
        conversation: "parallel-beta",
        text: "Reply with exactly TELEX_BETA_E2E_OK.",
      }),
    ]);
    expectMarker(alpha, "TELEX_ALPHA_E2E_OK");
    expectMarker(beta, "TELEX_BETA_E2E_OK");
    if (alpha.finalText.includes("TELEX_BETA") || beta.finalText.includes("TELEX_ALPHA")) {
      throw new Error("Parallel conversation output crossed thread boundaries");
    }
  });

  await scenario(
    results,
    options.instance.trace,
    "scheduler through channel protocol",
    async () => {
      const created = await channel.send({
        conversation: "scheduler",
        text: 'Create a cron schedule named "E2E minute" that runs every minute, always notifies, and asks: Reply with TELEX_SCHEDULER_E2E_OK. After creating it, say TELEX_SCHEDULE_CREATED.',
      });
      expectMarker(created, "TELEX_SCHEDULE_CREATED");
      const owner: ProviderReference = {
        provider: channel.name,
        resource: "user",
        id: "operator",
      };
      const conversation: ProviderReference = {
        provider: channel.name,
        resource: "conversation",
        id: `${channel.name}:scheduler`,
      };
      const schedules = options.instance.scheduler.listForConversation(owner, conversation);
      if (schedules.length !== 1)
        throw new Error(`Expected one real schedule, found ${schedules.length}`);
      options.clock.advance(2 * 60_000);
      await options.instance.trace.span("Scheduler tick and scheduled run", async () => {
        await options.instance.scheduler.tick();
        await options.instance.scheduler.waitForIdle();
      });
      const published = await options.instance.trace.span(
        "Wait for scheduled channel delivery",
        async () => await channel.nextPublished(),
      );
      if (!published.message.text.includes("TELEX_SCHEDULER_E2E_OK")) {
        throw new Error(`Scheduled run returned unexpected output: ${published.message.text}`);
      }
    },
  );
  return results;
}

function requireProtocolChannel(channel: ProtocolE2eChannel | undefined): ProtocolE2eChannel {
  if (channel === undefined) throw new Error("The core E2E suite requires ProtocolE2eChannel");
  return channel;
}

function expectMarker(reply: E2eExchange, marker: string): void {
  if (!reply.finalText.includes(marker)) {
    throw new Error(`Expected ${marker}, received: ${reply.finalText || reply.texts.join("\n")}`);
  }
}

async function scenario(
  results: E2eScenarioResult[],
  trace: E2eTrace,
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  trace.beginScenario(name);
  let entries: readonly E2eTraceEntry[] = [];
  try {
    await run();
  } finally {
    entries = trace.finishScenario(name);
  }
  results.push({ name, durationMs: Date.now() - startedAt, trace: entries });
}

function isImage(attachment: E2eCapturedAttachment | undefined): boolean {
  const bytes = attachment?.content;
  if (bytes === undefined || bytes.byteLength < 4) return false;
  return (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    bytes.subarray(0, 4).toString("ascii") === "GIF8" ||
    (bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP")
  );
}
