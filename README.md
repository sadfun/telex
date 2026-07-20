# Telex

Telex is a self-hosted Telegram bridge for OpenAI Codex. Telegram is only the transport: a dedicated [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) owns threads, turns, tools, approvals, authentication, and configuration.

Telex supports private conversations, automatic Telegram voice-message transcription, photos and files in both directions, forwarded and replied-to context, polls and other structured messages, streamed replies and thinking, interactive approvals, guest mentions, persistent Codex threads, and an authenticated settings Mini App. It installs a pinned Codex CLI into isolated application storage, so it never depends on a global Codex installation.

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
    └── conversations.json
```

Use `--install-dir`, `--config-dir`, `--bin-dir`, `--version`, or `--no-service` to customize the installation. Run the installer with `--help` for details. Re-running it is safe and preserves existing configuration and data.

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

Configuration, conversations, Codex authentication, Codex configuration, and the workspace live outside release directories and are preserved. A failed download, checksum, extraction, or validation leaves the active release unchanged.

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
| `/new` | Interrupt the current turn, forget its thread, and start fresh on the next message. |
| `/stop` | Interrupt the running Codex turn. |
| `/status` | Check app-server connectivity and the current Codex account. |
| `/login` | Start Codex's ChatGPT device-code login in a private chat. |
| `/logout` | Sign out through Codex in a private chat. |
| `/config` | Open the authenticated settings Mini App in a private chat. |
| `/update` | Check for and install the latest Telex release, then restart the service. |
| `/help` | Show the command list. |

Messages that are not commands become `turn/start` requests. Telegram voice messages are transcribed before the turn starts, while their original OGG files remain available to Codex. Photos and supported image files use Codex's native image input. Videos, other audio, documents, animated stickers, and other binary files are downloaded under `.telex/attachments` in the Codex workspace and passed as local paths; captions, replies, forwards, polls, contacts, locations, checklists, and Telegram-only structures are preserved as concise text context. Codex commentary drives Telegram's thinking indicator, final-answer deltas drive the draft, and approval or user-input requests become inline choices.

In the other direction, Telex uploads completed Codex image-generation results and regular workspace files explicitly linked in the final answer. JPEG and PNG images, GIF animations, MP4 videos, and MP3 or M4A audio use Telegram's native media methods; everything else is sent as a document. Native-media failures retry as documents, individual upload failures remain visible, and Telex snapshots canonically validated files before upload. Markdown links are limited to the configured workspace; structured image-generation outputs are also accepted from Codex's dedicated generated-image directory. Ordinary source edits, code examples, arbitrary paths, and unlinked files are never uploaded automatically.

Telegram's hosted Bot API only allows bots to download files up to 20 MB and upload general files up to 50 MB. Telex still forwards the file metadata and a clear limitation notice when a download or upload is unavailable. Set `TELEGRAM_API_BASE` to a [local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server) to remove the download limit and support larger uploads.

## Settings Mini App

The Mini App uses [TelegramUI](https://github.com/telegram-mini-apps-dev/TelegramUI) and accepts only signed Telegram `initData` from allowlisted private users. It covers the everyday settings from Codex's [basic configuration guide](https://learn.chatgpt.com/docs/config-file/config-basic), including models, reasoning, approval policy, permission profiles, sandboxing, web search, shell environment, and supported feature flags.

Choices come from the running app-server and active configuration layers instead of a handwritten catalog. Every edit is previewed by the same server-side validator used for saves. A save is a version-checked `config/batchWrite`, so all changes either pass Codex validation and land together or leave `config.toml` untouched. The app-server runs with `--strict-config`, so unknown configuration keys fail loudly.

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
