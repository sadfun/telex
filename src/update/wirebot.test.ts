import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAppConfig } from "../config/env.js";
import { atomicWriteJson } from "../shared/fs.js";
import { Logger } from "../shared/logger.js";
import { runCommand } from "../shared/process.js";
import { bindMount, Docker, wirebotImage } from "./docker.js";
import {
  acquireRuntimeLock,
  maintainWirebot,
  migrationDirectory,
  migrationMessage,
  prepareMigration,
  runWithWirebot,
  updateWirebot,
} from "./wirebot.js";
import { launchAgent, systemdUnits, updaterScript, wirebotService } from "./wirebot-service.js";

test("migration preserves 0.0.34 state and survives failed/interrupted image updates", {
  timeout: 30_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "telex-migration-test-"));
  const savedEnv = { ...process.env };
  const logger = new Logger("error");
  const oldImage = `sha256:${"a".repeat(64)}`;
  const newImage = `sha256:${"b".repeat(64)}`;
  let latestImage = oldImage;
  let failPull = false;
  let failReady = false;
  let blockCheckpoint: string | undefined;
  let liveData: string | undefined;
  let checks = 0;
  const commands: string[][] = [];
  let activations = 0;
  let failService = false;
  t.mock.method(wirebotService, "prepare", async (directory: string) => {
    if (failService) throw new Error("simulated unavailable service manager");
    return async () => {
      activations += 1;
      await assert.rejects(stat(join(directory, "runtime.lock")), { code: "ENOENT" });
      await maintainWirebot(directory);
    };
  });
  const containers = new Map<
    string,
    {
      Image: string;
      Config: { Labels: Record<string, string> };
      State: { Running: boolean; Restarting: boolean; StartedAt: string };
    }
  >();
  t.mock.method(Docker.prototype, "container", async (name: string) => containers.get(name));
  t.mock.method(Docker.prototype, "copyData", async (source: string, destination: string) => {
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, verbatimSymlinks: true });
  });
  t.mock.method(Docker.prototype, "waitUntilReady", async (_name: string, expectAuth: boolean) => {
    checks += 1;
    if (checks === 1) assert.equal(expectAuth, true);
    if (blockCheckpoint !== undefined) {
      await rm(blockCheckpoint);
      await mkdir(blockCheckpoint);
    }
    if (failReady) {
      assert(liveData);
      await writeFile(join(liveData, "conversations.json"), "incompatible candidate state");
      throw new Error("simulated unhealthy candidate");
    }
  });
  t.mock.method(Docker.prototype, "run", async (args: string[]) => {
    commands.push([...args]);
    const last = args.at(-1) ?? "";
    switch (args[0]) {
      case "info":
        return "Docker is running";
      case "pull":
        if (failPull) throw new Error("simulated registry outage");
        assert.equal(last, wirebotImage);
        return "pulled";
      case "image":
        return latestImage;
      case "run": {
        const name = args[args.indexOf("--name") + 1] ?? "";
        assert(!containers.has(name));
        assert(
          ![...containers.values()].some((container) => container.State.Running),
          "two bot instances must never poll concurrently",
        );
        const label = args[args.indexOf("--label") + 1] ?? "";
        containers.set(name, {
          Image: last,
          Config: { Labels: { [label.split("=")[0] ?? ""]: name } },
          State: { Running: true, Restarting: false, StartedAt: new Date().toISOString() },
        });
        return name;
      }
      case "stop": {
        const container = containers.get(last);
        assert(container);
        container.State.Running = false;
        return last;
      }
      case "start": {
        const container = containers.get(last);
        assert(container);
        container.State.Running = true;
        return last;
      }
      case "rename": {
        const name = args[1] ?? "";
        const container = containers.get(name);
        assert(container);
        assert(!containers.has(last));
        containers.delete(name);
        containers.set(last, container);
        return last;
      }
      case "rm":
        containers.delete(last);
        return last;
      default:
        throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
    }
  });
  const messages: Array<{ chat_id: number; text: string }> = [];
  const telegram = createServer(async (request, response) => {
    assert(request.url?.endsWith("/sendMessage"));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    messages.push(JSON.parse(Buffer.concat(chunks).toString()));
    assert(checks > 0, "the announcement must follow readiness verification");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, result: { message_id: messages.length } }));
  });
  await new Promise<void>((resolve) => telegram.listen(0, "127.0.0.1", resolve));
  try {
    const address = telegram.address();
    assert(address && typeof address !== "string");
    Object.assign(process.env, {
      XDG_DATA_HOME: join(root, "host-state"),
      TELEX_DATA_DIR: join(root, "telex data"),
      CODEX_WORKSPACE: join(root, "custom workspace"),
      TELEGRAM_BOT_TOKEN: "123456:fake-token-for-migration-test",
      TELEGRAM_ALLOWED_USER_IDS: "123456",
      TELEGRAM_API_BASE: `http://127.0.0.1:${address.port}`,
      TELEX_TUNNEL: "off",
      TELEX_MIGRATION: "auto",
      PUBLIC_URL: "https://example.com",
      PORT: "9876",
      LOG_LEVEL: "error",
    });
    const config = loadAppConfig();
    const directory = migrationDirectory(config);
    const stateFile = join(directory, "migration.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const memory = join(config.workspace, ".telex", "automations", "schedule-1");
    await mkdir(memory, { recursive: true });
    await writeFile(join(memory, "memory.md"), "Remember the user's project.");
    await mkdir(join(config.dataDirectory, "codex-home", "sessions"), { recursive: true });
    await mkdir(join(config.dataDirectory, "codex-home", "memories"));
    const stateData = {
      version: 2,
      conversations: {
        "telegram:123456:0": { activeThreadId: "thread-a", previousThreadIds: ["thread-b"] },
        "telegram:-123:42": { activeThreadId: "topic-thread", previousThreadIds: [] },
        "telegram:123:direct:7": { activeThreadId: "direct-thread", previousThreadIds: [] },
      },
    };
    const settings = { version: 1, remoteClientContext: false };
    const instant = "2026-09-06T12:00:00Z";
    const reference = { provider: "telegram", resource: "conversation", id: "telegram:123456:0" };
    const automation = {
      id: "schedule-1",
      owner: { ...reference, resource: "user", id: "123456" },
      conversation: reference,
      deliveryTarget: { ...reference, resource: "destination", id: "opaque-target" },
      name: "Check project",
      prompt: "Check my project",
      status: "active",
      schedule: { rrule: "FREQ=DAILY", startAt: instant, timeZone: "Europe/Berlin" },
      threadId: "thread-a",
      notificationPolicy: "on-result",
      model: null,
      reasoningEffort: null,
      nextRunAt: instant,
      lastRunAt: null,
      deferredUntil: null,
      deferralReason: null,
      createdAt: instant,
      updatedAt: instant,
      revision: 2,
    };
    const automations = {
      version: 1,
      automations: { "schedule-1": automation },
      runs: {},
      notifications: {},
    };
    const authBytes =
      '{"auth_mode":"chatgpt","tokens":{"access_token":"preserve-me","refresh_token":"refresh-me","account_id":"account-1"}}';
    await atomicWriteJson(join(config.dataDirectory, "conversations.json"), stateData);
    await atomicWriteJson(join(config.dataDirectory, "settings.json"), settings);
    await atomicWriteJson(join(config.dataDirectory, "automations.json"), automations);
    await writeFile(join(config.dataDirectory, "codex-home", "auth.json"), authBytes, {
      mode: 0o600,
    });
    await writeFile(
      join(config.dataDirectory, "codex-home", "config.toml"),
      'cli_auth_credentials_store = "file"\nmodel = "custom-model"\n',
    );
    await writeFile(
      join(config.dataDirectory, "codex-home", "sessions", "rollout.jsonl"),
      '{"thread_id":"thread-a"}\n',
    );
    const database = Buffer.from([0, 17, 255, 42]);
    await writeFile(join(config.dataDirectory, "codex-home", "state_5.sqlite"), database);
    await writeFile(join(config.dataDirectory, "codex-home", "state_5.sqlite-wal"), database);
    await writeFile(
      join(config.dataDirectory, "codex-home", "memories", "MEMORY.md"),
      "Durable Codex memory",
    );
    const docker = new Docker(["fake-docker"]);
    let state = await prepareMigration(config, directory, docker, oldImage);
    liveData = state.dataDirectory;
    const copiedData = join(
      directory,
      (await readdir(directory)).find((name) => name.startsWith("data-")) ?? "missing",
    );
    for (const [file, expected] of [
      ["conversations.json", stateData],
      ["settings.json", settings],
      ["automations.json", automations],
    ] as const) {
      assert.deepEqual(JSON.parse(await readFile(join(copiedData, file), "utf8")), expected);
      assert.deepEqual(
        JSON.parse(await readFile(join(config.dataDirectory, file), "utf8")),
        expected,
      );
    }
    assert.equal(await readFile(join(copiedData, "codex-home", "auth.json"), "utf8"), authBytes);
    assert.deepEqual(
      await readFile(join(copiedData, "codex-home", "state_5.sqlite-wal")),
      database,
    );
    assert.equal(
      await readFile(join(copiedData, "codex-home", "memories", "MEMORY.md"), "utf8"),
      "Durable Codex memory",
    );
    const copiedWorkspace = join(copiedData, ".telex-external-workspace");
    assert.equal(await readlink(join(copiedWorkspace, ".wirebot")), ".telex");
    assert.equal(
      await readFile(
        join(copiedWorkspace, ".wirebot", "automations", "schedule-1", "memory.md"),
        "utf8",
      ),
      "Remember the user's project.",
    );
    assert(state.runArguments.some((arg) => arg.includes(`target=${config.workspace}`)));
    assert(state.runArguments.some((arg) => arg.includes(`target=${config.dataDirectory}`)));
    const environment = await readFile(join(directory, "wirebot.env"), "utf8");
    assert(environment.includes(`WIREBOT_DATA_DIR=${config.dataDirectory}\n`));
    assert(environment.includes("WIREBOT_TUNNEL=off\n"));
    assert(environment.includes("PUBLIC_URL=https://example.com\n"));
    assert(environment.includes("HOST=0.0.0.0\nPORT=8787\n"));
    assert.equal((await stat(join(directory, "wirebot.env"))).mode & 0o777, 0o600);
    await atomicWriteJson(stateFile, state);
    const noFallback = async () => {
      assert.fail("an active migration must not run Telex");
    };
    await runWithWirebot(noFallback);
    state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.status, "active");
    assert.deepEqual(state.notifiedUserIds, [123456]);
    assert.deepEqual(messages, [
      {
        chat_id: 123456,
        text: migrationMessage,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    ]);
    assert.equal(
      containers.get(state.name)?.State.Running,
      true,
      "the migration process exits while Docker keeps Wirebot running",
    );
    assert.equal(activations, 1);
    assert.equal(await readFile(join(directory, "current-image"), "utf8"), `${oldImage}\n`);
    await assert.rejects(stat(join(directory, "maintenance-needed")), { code: "ENOENT" });
    // Even an opt-out cannot accidentally launch stale Telex alongside migrated Wirebot.
    process.env.TELEX_MIGRATION = "off";
    await runWithWirebot(noFallback);
    assert.equal(messages.length, 1, "successful announcements must not repeat on restart");
    await docker.run(["start", state.name]);

    const signal = new AbortController().signal;
    const beforePull = commands.length;
    failPull = true;
    await assert.rejects(
      updateWirebot(docker, stateFile, state, signal, logger),
      /registry outage/u,
    );
    assert(!commands.slice(beforePull).some((args) => args[0] === "stop"));
    failPull = false;
    latestImage = newImage;
    failReady = true;
    await assert.rejects(updateWirebot(docker, stateFile, state, signal, logger), /unhealthy/u);
    assert.equal(containers.get(state.name)?.Image, oldImage);
    assert.equal(containers.get(state.name)?.State.Running, true);
    assert(!containers.has(`${state.name}-previous`));
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).image, oldImage);
    assert.deepEqual(
      JSON.parse(await readFile(join(liveData, "conversations.json"), "utf8")),
      stateData,
      "rollback must restore data modified by the failed candidate",
    );
    failReady = false;
    state = await updateWirebot(docker, stateFile, state, signal, logger);
    assert.equal(state.image, newImage);
    assert.equal(containers.get(state.name)?.Image, newImage);
    const beforeNoop = commands.length;
    await updateWirebot(docker, stateFile, state, signal, logger);
    assert(!commands.slice(beforeNoop).some((args) => args[0] === "stop"));

    // Recover a crash after renaming the old container but before creating its replacement.
    await docker.run(["stop", state.name]);
    await docker.run(["rename", state.name, `${state.name}-previous`]);
    await runWithWirebot(noFallback);
    assert(containers.has(state.name));
    assert(!containers.has(`${state.name}-previous`));

    const lock = join(directory, "runtime.lock");
    const unlock = await acquireRuntimeLock(lock);
    await assert.rejects(acquireRuntimeLock(lock), /already running/u);
    await unlock();
    await atomicWriteJson(join(config.dataDirectory, "conversations.json"), {
      version: 2,
      conversations: { broken: {} },
    });
    await assert.rejects(prepareMigration(config, directory, docker, oldImage));
    assert.equal(
      await readFile(join(config.dataDirectory, "codex-home", "auth.json"), "utf8"),
      authBytes,
    );
    await atomicWriteJson(join(config.dataDirectory, "conversations.json"), stateData);
    containers.clear();
    state = { ...state, status: "prepared", notifiedUserIds: [] };
    await atomicWriteJson(stateFile, state);
    failService = true;
    assert.equal(await runWithWirebot(async () => "telex-fallback"), "telex-fallback");
    assert.equal(containers.size, 0, "missing scheduler must fail before starting Wirebot");
    assert.equal(messages.length, 1);
    failService = false;
    await atomicWriteJson(stateFile, state);
    failReady = true;
    assert.equal(await runWithWirebot(async () => "telex-fallback"), "telex-fallback");
    assert.equal(containers.size, 0);
    assert.equal(messages.length, 1, "failed migration must not announce success");
    assert.deepEqual(
      JSON.parse(await readFile(join(config.dataDirectory, "conversations.json"), "utf8")),
      stateData,
    );
    // Readiness is the handoff boundary: checkpoint failure must never start stale Telex.
    failReady = false;
    await atomicWriteJson(stateFile, state);
    blockCheckpoint = stateFile;
    await assert.rejects(runWithWirebot(noFallback));
    assert.equal(containers.get(state.name)?.State.Running, true);
    assert.equal(messages.length, 1);
  } finally {
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduled shell checks exit without Node when the image is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "wirebot shell '$-"));
  const name = "telex-wirebot-0123456789ab";
  const oldImage = `sha256:${"a".repeat(64)}`;
  const newImage = `sha256:${"b".repeat(64)}`;
  const script = join(root, "update.sh");
  const docker = join(root, "docker");
  const maintenance = join(root, "maintain");
  try {
    await writeFile(
      docker,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> docker-calls
case "$1" in
  inspect) cat status ;;
  pull) [ ! -f fail-pull ] ;;
  image) cat latest ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    await writeFile(
      maintenance,
      `#!/bin/sh
set -eu
[ "$1" = 'literal $HOME $(touch injected)' ]
printf 'called\\n' >> maintenance-calls
[ ! -f fail-maintenance ]
`,
      { mode: 0o700 },
    );
    await writeFile(
      script,
      updaterScript(
        root,
        name,
        [docker],
        [maintenance, "literal $HOME $(touch injected)"],
        "  printf 'retired\\n' >> retirement",
      ),
    );
    await writeFile(join(root, "current-image"), oldImage);
    await writeFile(join(root, "latest"), oldImage);
    await writeFile(join(root, "status"), `true false ${oldImage} ${name}`);
    const check = () => runCommand("/bin/sh", [script], { cwd: root, timeout: 5_000 });
    await check();
    await check();
    assert.equal(await readFile(join(root, "retirement"), "utf8"), "retired\n");
    await assert.rejects(stat(join(root, "maintenance-calls")), { code: "ENOENT" });
    await assert.rejects(stat(join(root, "maintenance-needed")), { code: "ENOENT" });

    await writeFile(join(root, "fail-pull"), "");
    await assert.rejects(check());
    await assert.rejects(stat(join(root, "maintenance-calls")), { code: "ENOENT" });
    await rm(join(root, "fail-pull"));
    await writeFile(join(root, "latest"), newImage);
    await check();
    assert.equal(await readFile(join(root, "maintenance-calls"), "utf8"), "called\n");
    await stat(join(root, "maintenance-needed"));
    await assert.rejects(stat(join(root, "injected")), { code: "ENOENT" });
    // A failed/interrupted transaction must retry even if the registry tag changes back.
    await writeFile(join(root, "latest"), oldImage);
    await writeFile(join(root, "fail-maintenance"), "");
    await assert.rejects(check());
    await stat(join(root, "maintenance-needed"));
    await rm(join(root, "fail-maintenance"));
    await check();
    assert.equal((await readFile(join(root, "maintenance-calls"), "utf8")).split("\n").length, 4);
    await rm(join(root, "maintenance-needed"));
    await writeFile(join(root, "status"), `false false ${oldImage} ${name}`);
    await check();
    await stat(join(root, "maintenance-needed"));
    const units = systemdUnits(script, 21_600);
    assert.match(units.service, /Type=oneshot/u);
    assert.match(units.service, /Restart=no/u);
    assert.match(units.service, /\$\$/u);
    assert.match(units.timer, /OnUnitInactiveSec=21600s/u);
    const plist = launchAgent(name, `${script}&`, 21_600);
    assert(!plist.includes("KeepAlive"));
    assert.match(plist, /<key>StartInterval<\/key><integer>21600<\/integer>/u);
    assert(plist.includes("&amp;"));
    if (process.platform === "darwin") {
      await writeFile(join(root, "test.plist"), plist);
      await runCommand("plutil", ["-lint", join(root, "test.plist")], { cwd: root });
    }
    if (process.env.TELEX_TEST_SYSTEMD === "1") {
      assert.equal(process.platform, "linux");
      assert.equal(process.getuid?.(), 0);
      const unit = `telex-test-${crypto.randomUUID()}`;
      const legacy = `${unit}-legacy.service`;
      const files = [legacy, `${unit}.service`, `${unit}.timer`];
      const ctl = (...args: string[]) =>
        runCommand("systemctl", args, { cwd: root, timeout: 20_000 });
      try {
        await writeFile(
          join("/run/systemd/system", legacy),
          "[Service]\nExecStart=/bin/sleep infinity\nRestart=always\n[Install]\nWantedBy=multi-user.target\n",
        );
        await writeFile(join("/run/systemd/system", `${unit}.service`), units.service);
        await writeFile(join("/run/systemd/system", `${unit}.timer`), units.timer);
        await writeFile(
          script,
          updaterScript(
            root,
            name,
            [docker],
            [maintenance, "literal $HOME $(touch injected)"],
            `  systemctl disable --now ${legacy}`,
          ),
        );
        await rm(join(root, "service-retired"));
        await rm(join(root, "maintenance-needed"));
        await writeFile(join(root, "status"), `true false ${oldImage} ${name}`);
        const before = await readFile(join(root, "maintenance-calls"), "utf8");
        await ctl("daemon-reload");
        await ctl("enable", "--now", legacy);
        await ctl("enable", "--now", `${unit}.timer`);
        await ctl("start", `${unit}.service`);
        assert.equal(
          (await ctl("show", legacy, "-p", "ActiveState", "--value")).stdout.trim(),
          "inactive",
        );
        assert.equal(
          (await ctl("show", legacy, "-p", "UnitFileState", "--value")).stdout.trim(),
          "disabled",
        );
        assert.equal(
          (await ctl("show", `${unit}.service`, "-p", "MainPID", "--value")).stdout.trim(),
          "0",
        );
        assert.equal(
          (await ctl("show", `${unit}.timer`, "-p", "ActiveState", "--value")).stdout.trim(),
          "active",
        );
        assert.equal(await readFile(join(root, "maintenance-calls"), "utf8"), before);
      } finally {
        await ctl("disable", "--now", `${unit}.timer`, legacy);
        await ctl("stop", `${unit}.service`);
        for (const file of files) await rm(join("/run/systemd/system", file), { force: true });
        await ctl("daemon-reload");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the published Wirebot image boots with migrated data and a simulated Telegram API", {
  skip: process.env.TELEX_TEST_DOCKER !== "1",
  timeout: 600_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "telex-container-test-"));
  const docker = new Docker(["docker"]);
  const signal = AbortSignal.timeout(500_000);
  let name: string | undefined;
  let image: string | undefined;
  let polls = 0;
  const telegram = createServer((request, response) => {
    const method = request.url?.split("/").at(-1);
    if (method === "getUpdates") polls += 1;
    const result =
      method === "getMe"
        ? { id: 123456, is_bot: true, first_name: "Migration Test", username: "migration_test_bot" }
        : method === "getUpdates"
          ? []
          : true;
    const reply = () => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, result }));
    };
    if (method === "getUpdates") setTimeout(reply, 100);
    else reply();
  });
  await new Promise<void>((resolve) => telegram.listen(0, "0.0.0.0", resolve));
  try {
    const address = telegram.address();
    assert(address && typeof address !== "string");
    const config = loadAppConfig({
      TELEGRAM_BOT_TOKEN: "123456:fake-token-for-container-test",
      TELEGRAM_ALLOWED_USER_IDS: "123456",
      TELEGRAM_API_BASE: `http://host.docker.internal:${address.port}`,
      TELEX_DATA_DIR: join(root, "original-data"),
      CODEX_WORKSPACE: join(root, "original-data", "workspace"),
      TELEX_TUNNEL: "off",
    });
    const directory = join(root, "migration");
    await mkdir(directory);
    await mkdir(join(config.dataDirectory, "codex-home"), { recursive: true });
    await mkdir(join(config.workspace, ".telex", "automations", "schedule-1"), { recursive: true });
    await writeFile(
      join(config.workspace, ".telex", "automations", "schedule-1", "memory.md"),
      "preserved memory",
    );
    const codexConfig =
      'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\ncli_auth_credentials_store = "file"\n';
    await writeFile(join(config.dataDirectory, "codex-home", "config.toml"), codexConfig);
    await atomicWriteJson(join(config.dataDirectory, "conversations.json"), {
      version: 2,
      conversations: {
        "telegram:123456:0": {
          activeThreadId: "preserved-thread",
          previousThreadIds: ["previous-thread"],
        },
      },
    });
    await docker.run(["pull", wirebotImage], signal);
    image = await docker.run(["image", "inspect", "--format", "{{.Id}}", wirebotImage], signal);
    const state = await prepareMigration(config, directory, docker, image);
    name = state.name;
    await docker.run(
      [
        "run",
        "--detach",
        ...state.runArguments,
        "--add-host",
        "host.docker.internal:host-gateway",
        image,
      ],
      signal,
    );
    try {
      await docker.waitUntilReady(name, false, signal);
    } catch (error) {
      console.error(await docker.run(["logs", name]));
      throw error;
    }
    assert(polls > 0);
    assert.equal(
      await docker.run([
        "exec",
        name,
        "cat",
        join(config.workspace, ".wirebot", "automations", "schedule-1", "memory.md"),
      ]),
      "preserved memory",
    );
    const mapping = JSON.parse(
      await docker.run(["exec", name, "cat", join(config.dataDirectory, "conversations.json")]),
    );
    assert.equal(mapping.conversations["telegram:123456:0"].activeThreadId, "preserved-thread");
    const copiedConfig = await docker.run([
      "exec",
      name,
      "cat",
      join(config.dataDirectory, "codex-home", "config.toml"),
    ]);
    assert(copiedConfig.includes('sandbox_mode = "danger-full-access"'));
    assert(copiedConfig.includes('approval_policy = "on-request"'));
    assert.equal(
      await readFile(join(config.dataDirectory, "codex-home", "config.toml"), "utf8"),
      codexConfig,
    );
    await docker.run(["stop", "--time", "60", name]);
    await docker.copyData(state.dataDirectory, `${state.dataDirectory}-backup`, image);
    await docker.copyData(`${state.dataDirectory}-backup`, state.dataDirectory, image);
    await docker.run(["start", name]);
    await docker.waitUntilReady(name, false, signal);
  } finally {
    if (name !== undefined && (await docker.container(name)) !== undefined)
      await docker.run(["rm", "--force", name]);
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
    if (image !== undefined) {
      await docker.run([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0",
        "--entrypoint",
        "sh",
        "--mount",
        bindMount(root, "/cleanup"),
        image,
        "-c",
        "find /cleanup -mindepth 1 -delete",
      ]);
    }
    await rm(root, { recursive: true, force: true });
  }
});
