# Telex

Telex is a self-hosted Telegram bridge for OpenAI Codex. Telegram is only the transport: a dedicated [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) owns threads, turns, tools, approvals, authentication, and configuration.

Telex supports private conversations, scheduled runs, automatic Telegram voice-message transcription, photos and files in both directions, forwarded and replied-to context, polls and other structured messages, streamed replies and thinking, interactive approvals, guest mentions, persistent Codex threads, and an authenticated settings Mini App. It installs a pinned Codex CLI into isolated application storage, so it never depends on a global Codex installation.

## Requirements

- macOS or Linux
- Node.js 24 or newer and npm
- `curl` and `tar`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- The numeric Telegram user IDs allowed to use the bot
- Optionally, a public HTTPS URL for the settings Mini App; without one, Telex exposes it through an automatic quick tunnel

In BotFather, enable guest mode if the bot should answer mentions in group chats. Guest replies are intentionally one-shot: they do not persist a thread, cannot answer interactive approval prompts, and cannot upload newly generated local files. When a guest result includes a file, Telex explains that file attachments require a direct bot chat instead of silently omitting it.

## Install a release

The installer downloads the latest GitHub Release, verifies its SHA-256 checksum, installs it into a versioned directory, creates a `telex` command, and writes a user service definition.

```sh
curl -fsSL https://raw.githubusercontent.com/sadfun/telex/main/scripts/install.sh | sh
```

If you prefer to inspect scripts before running them:

```sh
curl -fsSLO https://raw.githubusercontent.com/sadfun/telex/main/scripts/install.sh
less install.sh
sh install.sh
```

The default layout is:

```text
~/.local/bin/telex                     # command symlink
~/.config/telex/telex.env             # secrets and runtime settings
~/.local/share/telex/
├── bin/telex                          # stable launcher
├── current -> releases/0.1.0          # atomically switched by updates
├── releases/                          # current and rollback releases
└── data/
    ├── codex-home/                    # Codex login and config.toml
    ├── toolchains/                    # isolated pinned Codex CLIs
    ├── workspace/                     # Codex working directory
    ├── conversations.json
    └── automations.json               # schedules, runs, and notifications
```

Use `--install-dir`, `--config-dir`, `--bin-dir`, `--version`, or `--no-service` to customize the installation. Run the installer with `--help` for details. Re-running it is safe and preserves existing configuration and data.

Telex intentionally sets `CODEX_HOME` to its own `data/codex-home`. Changes under the interactive CLI's usual `~/.codex` do not affect this app-server. Put user config, MCP definitions, and personal skills in Telex's Codex home (for example `data/codex-home/config.toml` and `data/codex-home/skills`), or use project-scoped files inside the configured workspace.

### Configure and start

Edit `~/.config/telex/telex.env` and replace these two values:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_IDS=123456789
```

`TELEGRAM_ALLOWED_USER_IDS` is a comma-separated list. Messages from other accounts are ignored, including guest-mode mentions. To expose the settings Mini App, also set its HTTPS origin:

```dotenv
PUBLIC_URL=https://codex.example.com
```

That origin must reverse-proxy to the configured `HOST` and `PORT` (defaults: `127.0.0.1:8787`).

When `PUBLIC_URL` is unset, Telex opens a [TryCloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) to the Mini App server, so `/config` works with no proxy setup at all. Telex uses [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) from the `PATH` when present; otherwise it downloads the pinned official release into its own toolchains directory and verifies its SHA-256 checksum first, the same way it manages the Codex CLI. Quick tunnels are best-effort: the `trycloudflare.com` URL changes on every start and Cloudflare offers no uptime guarantee, so set `PUBLIC_URL` for a persistent deployment. Set `TELEX_TUNNEL=off` to never open a tunnel; without a tunnel or `PUBLIC_URL`, Telex runs without the `/config` button. The Mini App validates signed Telegram `initData` against the allowlist regardless of how it is exposed.

Start the user service on Linux:

```sh
systemctl --user daemon-reload
systemctl --user enable --now telex
journalctl --user -u telex -f
```

Start it on macOS:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sadfun.telex.plist
tail -f ~/.local/share/telex/logs/telex.log
```

For a foreground process instead, install with `--no-service` and run `telex start` under your preferred process manager.

### Authenticate Codex

After Telex is running, open a private chat with the bot and send `/login`. Follow the device-code link and complete ChatGPT sign-in. The Codex app-server stores the resulting credentials in Telex's dedicated `data/codex-home`, so restarts and application updates do not require another login. `/status` shows the active account, and `/logout` removes it.

No OpenAI API key is required for the ChatGPT login flow.

Voice messages use that same ChatGPT subscription. Telex briefly shows a **Transcribing…** thinking block, sends the OGG recording to ChatGPT's Codex dictation service with `originator: Telex`, and then starts the normal Codex turn with both the transcript and original attachment. Token renewal goes through Codex app-server's native managed-auth refresh flow; Telex does not create dummy turns. On first use, Telex downloads a pinned, checksum-verified browser-compatible HTTP transport into its toolchains directory so this works without Chrome, Python, or a local speech model.

## Application updates

Installer-based setups default to:

```dotenv
TELEX_UPDATE_MODE=auto
TELEX_UPDATE_INTERVAL_HOURS=6
```

Telex checks GitHub's latest stable Release on startup and at that interval. When an update exists, it:

1. downloads the versioned archive and checksum assets from the Release;
2. verifies the GitHub asset size and SHA-256 checksum;
3. extracts and validates the bundle in a staging directory;
4. atomically switches the `current` symlink; and
5. shuts down cleanly so systemd or launchd restarts the new version.

Configuration, conversations, scheduled runs, Codex authentication, Codex configuration, and the workspace live outside release directories and are preserved. A failed download, checksum, extraction, or validation leaves the active release unchanged.

Set `TELEX_UPDATE_MODE=notify` to log available releases without installing them, or `off` to disable checks. `TELEX_UPDATE_REPOSITORY=owner/repository` makes a fork its update source.

Manual commands are also available:

```sh
telex version
telex update --check
telex update
```

`telex update --check` exits with status 10 when an update is available and 0 when current. After a manual update, restart the service:

```sh
# Linux
systemctl --user restart telex

# macOS
launchctl kickstart -k gui/$(id -u)/com.sadfun.telex
```

Older installed releases are retained for rollback. List them and activate one explicitly:

```sh
ls ~/.local/share/telex/releases
telex update --rollback 0.1.0
```

Then restart the service. Rollback changes application code only; it does not revert persistent data or configuration.

## Telegram commands

| Command | Effect |
| --- | --- |
| `/start` | Show setup guidance and start sign-in when required. |
| `/new` | Interrupt the current turn, forget its thread, and start fresh on the next message. |
| `/back` | Return to the previously active Codex task. |
| `/stop` | Interrupt the running Codex turn. |
| `/schedules` | List your scheduled runs and their next execution times. |
| `/status` | Check app-server connectivity and the current Codex account. |
| `/login` | Start Codex's ChatGPT device-code login in a private chat. |
| `/logout` | Sign out through Codex in a private chat. |
| `/config` | Open the authenticated settings Mini App in a private chat. |
| `/reload` | Reload config, MCP servers, and skills through Codex's native app-server APIs. |
| `/restart` | Drain active work and safely restart only the Codex app-server. |
| `/update` | Check for and install the latest Telex release, then restart the service. |
| `/help` | Show the command list. |

Messages that are not commands become `turn/start` requests. Telegram voice messages are transcribed before the turn starts, while their original OGG files remain available to Codex. Photos and supported image files use Codex's native image input. Videos, other audio, documents, animated stickers, and other binary files are downloaded under `.telex/attachments` in the Codex workspace and passed as local paths; captions, replies, forwards, polls, contacts, locations, checklists, and Telegram-only structures are preserved as concise text context. Codex commentary drives Telegram's thinking indicator, final-answer deltas drive the draft, and approval or user-input requests become inline choices.

Every turn also carries connector-derived application context separately from the user's message. It tells Codex that the user is remote through the current connector, so host-local browser windows, GUI state, and `localhost` links are not user-accessible. The connector name is dynamic rather than Telegram-specific, preserving the channel abstraction for future transports.

In the other direction, Telex uploads completed Codex image-generation results and regular workspace files explicitly linked in the final answer. JPEG and PNG images, GIF animations, MP4 videos, and MP3 or M4A audio use Telegram's native media methods; everything else is sent as a document. Native-media failures retry as documents, individual upload failures remain visible, and Telex snapshots canonically validated files before upload. Markdown links are limited to the configured workspace; structured image-generation outputs are also accepted from Codex's dedicated generated-image directory. Ordinary source edits, code examples, arbitrary paths, and unlinked files are never uploaded automatically.

Telegram's hosted Bot API only allows bots to download files up to 20 MB and upload general files up to 50 MB. Telex still forwards the file metadata and a clear limitation notice when a download or upload is unavailable. Set `TELEGRAM_API_BASE` to a [local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server) to remove the download limit and support larger uploads.

## Scheduled runs

Ask Codex naturally, for example, “Every weekday at 9, check this project for failed CI runs” or “Revisit this task every hour and notify me only if something changed.” Telex exposes a host-managed `automation_update` tool to new Codex tasks and stores each schedule with an explicit time zone. A task created before upgrading does not have that tool in its persisted definition; send `/new` once before asking it to create or edit schedules. `/schedules` remains available for viewing them.

The initial recurrence engine accepts a bounded RRULE subset covering minutely, hourly, daily, and weekly schedules. It rejects multi-line, unusually dense, or computationally expensive rules instead of allowing schedule evaluation to stall the bridge.

Scheduled runs follow the [Codex Desktop scheduled-task model](https://developers.openai.com/codex/app/automations):

- A cron run starts a fresh persistent Codex task for each occurrence. A heartbeat revisits the Codex task in which it was created.
- When the scheduler claims work, an active or waiting user message makes it defer and retry. If an unattended run has already started, a later message shows a queued status and begins as soon as that run finishes.
- Heartbeats can suppress unimportant results. Cron results notify by default, and delivery failures are recorded without rerunning already completed work.
- Each schedule gets a small durable memory file under the workspace's `.telex/automations` directory, which the run reads and may update.

Notifications deliberately do not change the active task, including in a Telegram chat without topics. Your next ordinary message still goes to the task you were already using. Replying to a scheduled notification also stays in that task, but Telex supplies the complete stored result as additional context even when Telegram split or truncated the visible message. **Continue this run** explicitly switches to the notification's source task when the conversation is idle; `/back` returns to the previous task.

Scheduling and delivery state use opaque provider references rather than Telegram message or chat fields. Telegram is the first adapter; future messaging providers can define their own destination and message identifier formats without changing the scheduler.

Telex retains the latest 100 run and notification records for each schedule so local state stays bounded. Older provider messages remain in the provider, but Telex may no longer have enough retained context to resume or expand them.

### The one custom-harness exception

Telex's design rule is to use Codex's native app-server behavior instead of building a custom agent harness. The scheduled-runs engine is the one exception because Codex Desktop already implements scheduling in its host application rather than in Codex CLI. Telex mirrors that approach nearly 1:1: the host claims due work, applies foreground priority, persists run and notification state, and asks Codex to execute normal turns. As soon as Codex CLI or app-server provides native cron ownership, Telex will switch to it immediately and retire this engine.

The service must be running when work becomes due; this is not a cloud scheduler and it does not wake a powered-off machine. The initial implementation runs only against Telex's configured local workspace.

## Settings Mini App

The Mini App uses [TelegramUI](https://github.com/telegram-mini-apps-dev/TelegramUI) and accepts only signed Telegram `initData` from allowlisted private users. It includes a default-on remote session context toggle and covers the everyday settings from Codex's [basic configuration guide](https://learn.chatgpt.com/docs/config-file/config-basic), including models, reasoning, approval policy, permission profiles, sandboxing, web search, shell environment, and supported feature flags. Turning remote session context off stops Telex from adding its connector-aware instructions to Codex turns.

Choices come from the running app-server and active configuration layers instead of a handwritten catalog. Every edit is previewed by the same server-side validator used for saves. A save is a version-checked `config/batchWrite`, so all changes either pass Codex validation and land together or leave `config.toml` untouched. The app-server runs with `--strict-config`, so unknown configuration keys fail loudly.

Telex keeps the running Codex process synchronized using the [app-server mechanisms designed for this purpose](https://learn.chatgpt.com/docs/app-server#api-overview):

- Mini App saves hot-reload the effective user configuration and carry supported model, approval, and reasoning choices into the next turn.
- File-backed active config layers are watched through `fs/watch`; valid external edits trigger the same reconciliation, while invalid edits leave the last healthy runtime active and show a degraded status.
- Skills use Codex's built-in watcher plus a forced `skills/list` refresh. Explicit `$skill-name` mentions are sent as native skill inputs.
- MCP definitions use `config/mcpServer/reload`. Codex queues refreshed MCP state for loaded threads, so it becomes active on their next turn.

The runtime card in the Mini App shows the current outcome and offers **Apply changes** and **Restart Codex**. `/reload` and `/restart` provide the same private-chat controls. Restart is the fallback for startup-only state: Telex pauses new turns, lets active turns finish, restarts its child app-server with the same `CODEX_HOME`, reloads watches and resources, and lazily resumes persisted thread IDs. It does not restart the Telegram bridge or discard authentication and conversation history.

## Source development

```sh
git clone https://github.com/sadfun/telex.git
cd telex
npm install
cp .env.example .env
npm run build
npm start
```

Source checkouts only notify about Telex releases; they are not modified by the release updater. Update a checkout through Git instead.

Development commands:

```sh
npm run check
npm test
npm run dev
```

The handwritten application is strict TypeScript 7. Messaging transports depend only on `src/core/channel.ts`; Telegram is the first implementation.

### Codex protocol updates

Application updates and Codex protocol updates are intentionally separate. Each Telex release ships the exact compatible Codex CLI version recorded in `codex.version`. Startup installs that version into Telex's isolated toolchain directory.

Maintainers can test a newer Codex protocol from a source checkout:

```sh
# Generate the candidate protocol and compile Telex against it.
npm run codex:check

# Apply it only after compatibility checks succeed.
npm run codex:update
```

The check uses the candidate binary's `app-server generate-ts` and `generate-json-schema` output, validates it, compares the RPC surface, and compiles the application. Removed methods or compile failures are not applied.

### Publishing a release

1. Update `package.json` and `package-lock.json` to the same semantic version.
2. Run `npm run check`, `npm test`, and `npm run build`.
3. Push a matching tag such as `v0.2.0`.

The Release workflow verifies the tag, runs the full checks, bundles compiled code with production dependencies, writes the SHA-256 asset, and publishes both assets to GitHub Releases. The updater accepts only assets named `telex-VERSION.tar.gz` and `telex-VERSION.tar.gz.sha256`.

## Uninstall

Stop and remove the user service first:

```sh
# Linux
systemctl --user disable --now telex
rm ~/.config/systemd/user/telex.service
systemctl --user daemon-reload

# macOS
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.sadfun.telex.plist
rm ~/Library/LaunchAgents/com.sadfun.telex.plist
```

Then remove `~/.local/bin/telex` and `~/.local/share/telex`. Remove `~/.config/telex` only if you also want to delete the bot configuration. Deleting `~/.local/share/telex/data` permanently removes conversations, Codex configuration, and Codex login state.

## License

Telex is released under the [Functional Source License 1.1 with an MIT future license](./LICENSE.md). Each published version becomes available under MIT two years after its release date.
