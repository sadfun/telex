import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidTvChannel } from "../src/channels/android-tv/channel.js";
import { AndroidTvDeviceStore } from "../src/channels/android-tv/device-store.js";
import { AndroidTvPairingService } from "../src/channels/android-tv/pairing.js";
import type { CodexService } from "../src/codex/service.js";
import type { InboundMessage } from "../src/core/channel.js";
import type { Thread } from "../src/generated/codex/v2/Thread.js";
import { Logger } from "../src/shared/logger.js";

const logger = new Logger("error");
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("Android TV adapter", () => {
  it("persists only a device-token hash and authenticates the original token", async () => {
    const { store, path } = await deviceStore();
    const registered = await store.register("Living room", {
      provider: "telegram",
      resource: "user",
      id: "42",
    });

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain(registered.token);
    expect(store.authenticate(registered.token)?.id).toBe(registered.device.id);
    expect(store.authenticate("not-the-token")).toBeUndefined();

    const reloaded = new AndroidTvDeviceStore(path, logger);
    await reloaded.load();
    expect(reloaded.authenticate(registered.token)?.owner.id).toBe("42");
  });

  it("runs pairing, owner-scoped sessions, interactive choice, and streamed chat end to end", async () => {
    const { store } = await deviceStore();
    const pairing = new AndroidTvPairingService(store);
    const readConversationThread = vi.fn(async (prefixes: readonly string[], id: string) => {
      expect(prefixes).toContain("telegram:42");
      expect(id).toBe(thread.id);
      return thread;
    });
    const codex = {
      listConversationThreads: vi.fn(async (prefixes: readonly string[]) => {
        expect(prefixes).toContain("telegram:42");
        return [thread];
      }),
      readConversationThread,
      activateConversationThread: vi.fn(async () => true),
    } as unknown as CodexService;
    const channel = new AndroidTvChannel({ devices: store, pairing, codex, logger });
    await channel.start(async (message: InboundMessage) => {
      const stream = message.responder.createStream();
      await stream.start({ summary: "Thinking", actions: [], plan: [] });
      const answer = await message.responder.askChoice("Proceed?", [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ]);
      stream.appendFinal("Selected ");
      await stream.complete(`Selected ${answer}`);
    });
    const origin = await serve(channel);

    const challengeResponse = await fetch(`${origin}/api/tv/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName: "Bedroom TV", appVersion: "test" }),
    });
    expect(challengeResponse.status).toBe(201);
    const challenge = (await challengeResponse.json()) as {
      pairingId: string;
      code: string;
    };
    expect(challenge.code).toMatch(/^\d{8}$/u);

    const approved = await pairing.approve(challenge.code, {
      provider: "telegram",
      resource: "user",
      id: "42",
    });
    expect(approved.status).toBe("approved");

    const pairingResponse = await fetch(
      `${origin}/api/tv/pairings/${encodeURIComponent(challenge.pairingId)}`,
    );
    const pairingResult = (await pairingResponse.json()) as {
      status: string;
      token: string;
    };
    expect(pairingResult.status).toBe("approved");
    const authorization = `Bearer ${pairingResult.token}`;

    const recoverableResponse = await fetch(
      `${origin}/api/tv/pairings/${encodeURIComponent(challenge.pairingId)}`,
    );
    expect(recoverableResponse.status).toBe(200);

    const sessionsResponse = await fetch(`${origin}/api/tv/sessions`, {
      headers: { authorization },
    });
    expect(sessionsResponse.status).toBe(200);
    expect(await sessionsResponse.json()).toMatchObject({
      sessions: [{ id: thread.id, title: "TV prototype" }],
    });
    const consumedResponse = await fetch(
      `${origin}/api/tv/pairings/${encodeURIComponent(challenge.pairingId)}`,
    );
    expect(consumedResponse.status).toBe(404);

    const abort = new AbortController();
    const eventsResponse = await fetch(`${origin}/api/tv/events`, {
      headers: { authorization },
      signal: abort.signal,
    });
    expect(eventsResponse.status).toBe(200);
    const events = sseReader(eventsResponse);

    const messageResponse = await fetch(`${origin}/api/tv/messages`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "Continue", threadId: thread.id }),
    });
    expect(messageResponse.status).toBe(202);
    const request = (await messageResponse.json()) as { requestId: string };

    const progress = await events.next("progress");
    expect(progress.requestId).toBe(request.requestId);
    const choice = await events.next("choice");
    expect(choice.payload).toMatchObject({ prompt: "Proceed?" });
    const choicePayload = choice.payload as { choiceId: string };
    const answerResponse = await fetch(
      `${origin}/api/tv/choices/${encodeURIComponent(choicePayload.choiceId)}`,
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ optionId: "yes" }),
      },
    );
    expect(answerResponse.status).toBe(200);
    expect((await events.next("delta")).payload).toEqual({ delta: "Selected " });
    expect((await events.next("complete")).payload).toMatchObject({ text: "Selected yes" });
    abort.abort();

    expect(readConversationThread).toHaveBeenCalled();
    expect((codex.activateConversationThread as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "android-tv:telegram:42",
    );
    const disconnectResponse = await fetch(`${origin}/api/tv/device`, {
      method: "DELETE",
      headers: { authorization },
    });
    expect(disconnectResponse.status).toBe(200);
    const revokedResponse = await fetch(`${origin}/api/tv/sessions`, {
      headers: { authorization },
    });
    expect(revokedResponse.status).toBe(401);
    await channel.stop();
  });

  it("rejects an unauthenticated session read", async () => {
    const { store } = await deviceStore();
    const pairing = new AndroidTvPairingService(store);
    const channel = new AndroidTvChannel({
      devices: store,
      pairing,
      codex: {} as CodexService,
      logger,
    });
    const origin = await serve(channel);

    const response = await fetch(`${origin}/api/tv/sessions`);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });
});

async function deviceStore(): Promise<{
  readonly store: AndroidTvDeviceStore;
  readonly path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "telex-tv-"));
  directories.push(directory);
  const path = join(directory, "android-tv-devices.json");
  const store = new AndroidTvDeviceStore(path, logger);
  await store.load();
  return { store, path };
}

async function serve(channel: AndroidTvChannel): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    void channel.handleHttp(request, response, url).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

function sseReader(response: Response): {
  next(type: string): Promise<{ readonly requestId?: string; readonly payload: unknown }>;
} {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Missing SSE body");
  const decoder = new TextDecoder();
  let buffer = "";
  const queued: Array<{ type: string; value: Record<string, unknown> }> = [];

  const next = async (
    type: string,
  ): Promise<{ readonly requestId?: string; readonly payload: unknown }> => {
    while (true) {
      const queuedIndex = queued.findIndex((event) => event.type === type);
      if (queuedIndex >= 0) {
        const event = queued.splice(queuedIndex, 1)[0];
        if (event === undefined) continue;
        return event.value as { readonly requestId?: string; readonly payload: unknown };
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`SSE ended before ${type}`);
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventType = /^event: (.+)$/mu.exec(frame)?.[1];
        const data = /^data: (.+)$/mu.exec(frame)?.[1];
        if (eventType !== undefined && data !== undefined) {
          queued.push({
            type: eventType,
            value: JSON.parse(data) as Record<string, unknown>,
          });
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  };
  return { next };
}

const thread = {
  id: "019fa111-1111-7111-8111-111111111111",
  sessionId: "019fa111-1111-7111-8111-111111111111",
  forkedFromId: null,
  parentThreadId: null,
  preview: "TV prototype",
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1_800_000_000,
  updatedAt: 1_800_000_100,
  recencyAt: 1_800_000_100,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace",
  cliVersion: "test",
  source: "appServer",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "TV prototype",
  turns: [],
} satisfies Thread;
