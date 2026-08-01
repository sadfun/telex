# Changelog

All notable changes to Telex are documented in this file.

## [0.0.29] - 2026-08-01

### Changed

- Replaced the mock-heavy unit suite with credentialed end-to-end engines for the core channel protocol and Telegram. They launch a disposable real Telex/Codex runtime, exercise text, voice transcription, image and document attachments, progress rendering, parallel conversations, and production scheduler delivery with only the clock controlled.
- Added an explicit external-token refresh provider for isolated Codex app-server instances and a programmatic, default-deny Telegram bot-sender exception used only by the bot-to-bot E2E runner.

### Fixed

- Extract the pinned voice transport without restoring archive ownership on Linux, so transcription installs under rootless containers and other restricted runtimes.

## [0.0.28] - 2026-08-01

### Fixed

- Restored a one-shot migration for pre-0.0.27 automation state, so existing deployments no longer fail startup after updating; 0.0.27 crash-looped on the old `kind`/`execution` format.

## [0.0.27] - 2026-08-01

### Changed

- The Mini App client now trusts the server's typed wire format directly — shared TypeScript types and JSX rendering replace ~900 lines of duplicated interfaces, hand-rolled JSON parsers, and `createElement` calls.
- Flattened the Codex runtime status to a single state (`ready`/`reloading`/`restarting`/`degraded`) instead of per-component readiness tracking, typed end to end from the runtime service through the bridge and Mini App.
- Merged the automations scheduler loop into the engine and generated the scheduling tool's JSON schema from its zod definition, so the model-facing contract can no longer drift from the validator.
- Sourced experimental-feature names and descriptions from Codex's `experimentalFeature/list` instead of a hardcoded table, and reduced model providers to the official OpenAI API per the project philosophy.
- Scheduled-run notifications now render markdown exactly like interactive replies.
- `npm start` and `npm run dev` route through the CLI entry point; the standalone bindings-generation script became a thin alias for `codex check --apply`.

### Removed

- The committed protocol JSON-schema artifacts (273 files, ~3.5 MB, read by nothing) and the protocol tooling's staged-compile, fingerprint-guard, and legacy-manifest machinery — `codex:update` now typechecks the applied bindings in place and rolls back on failure.
- Automatic reload when Codex config files change on disk outside Telex; the `/reload` command and the Mini App's **Apply changes** button perform the identical reconcile.
- The unreachable Telegram ephemeral-message path, the reflective payload file scanner that duplicated the media catalog, the 70-key fallback field list (unknown payload fields now surface as a bounded JSON remainder), client-side enterprise-requirements validation, persisted-format migrations, automation soft-delete tombstones, and the notification pending/delivered lifecycle.

### Fixed

- Guest inline replies no longer silently drop text sent after the initial answer; it is appended to the inline message instead.

## [0.0.26] - 2026-07-31

### Changed

- Rebuilt the Codex integration around the app-server's native per-thread event stream: every turn is rendered from its own `turn/started` → `item/*` → `turn/completed` notifications, so Codex-initiated turns (mailbox follow-ups, reviews) now arrive as their own chat messages instead of being spliced into the previous reply.
- Removed the successor-following, terminal-settlement-delay, and interrupt-error-parsing workarounds that approximated this behavior on top of a request/response model.
- Made `/stop` a standing stop intent on the thread: it interrupts every running turn and any successor Codex swaps in, until new work starts.

### Added

- Withdrew pending approval and question prompts when Codex resolves them elsewhere (`serverRequest/resolved`), so `/stop` no longer leaves live approval keyboards behind in Telegram.

## [0.0.24] - 2026-07-29

### Fixed

- Reconciled successor turns even when Codex reports their start before the previous terminal notification.
- Retried an explicit interrupt once with Codex's authoritative active turn ID when lifecycle notifications arrive out of order.

## [0.0.23] - 2026-07-29

### Fixed

- Followed Codex mailbox-triggered successor turns instead of dropping their lifecycle and output after the initiating turn completed.
- Kept `/stop`, `/new`, and shutdown interruption intent attached to the current successor turn so stale turn IDs no longer surface as Codex errors.

## [0.0.22] - 2026-07-26

### Fixed

- Paired Mini App switch tracks and thumbs with Telegram's `button_color` and `button_text_color` instead of a hard-coded white thumb.
- Derived filled destructive-action foregrounds from Telegram's live light/dark theme colors and removed the hard-coded hover blend.

## [0.0.20] - 2026-07-26

### Fixed

- Corrected the Mini App's Telegram theme mapping so the primary background colors the canvas, secondary backgrounds color cards, and section colors remain available for nested controls.
- Applied Telegram's dedicated subtitle, section-header, separator, and bottom-bar theme colors with fallbacks for older clients.

## [0.0.17] - 2026-07-23

### Fixed

- Allowed the Mini App to load its same-origin compiled stylesheet under the production Content Security Policy.
- Added a production-asset browser preview fixture and a regression test that keeps external stylesheet delivery and CSP permissions in sync.

## [0.0.16] - 2026-07-23

### Changed

- Rebuilt the settings Mini App with source-owned shadcn/ui components, Tailwind CSS, and Radix primitives while preserving Telegram theme colors and safe areas.
- Rendered skill instructions and Markdown resources as readable documents and condensed skill descriptions into compact two-line list rows.

### Fixed

- Fixed narrow-screen text overflow in skill details and long labels.
- Fixed the clean-state save bar and bottom navigation obscuring settings and skill content.

## [0.0.15] - 2026-07-23

### Added

- Added a persistent Mini App tab bar with the existing settings screen and a new **Skills** tab.
- Added an authenticated, read-only browser for every enabled Codex skill, including `SKILL.md`, bundled scripts, references, and image previews.

## [0.0.12] - 2026-07-21

### Fixed

- Removed the 30-minute wall-clock deadline for Codex turns so healthy long-running agents can continue until they complete or are explicitly interrupted.

## [0.0.8] - 2026-07-21

### Added

- Added native live reload for Codex configuration, MCP servers, and skills, including automatic reconciliation when active config files change outside Telex.
- Added a runtime status card and **Apply changes** and **Restart Codex** controls to the settings Mini App.
- Added `/reload` and `/restart` Telegram commands for the same private-chat runtime controls.
- Added native explicit-skill inputs for `$skill-name` mentions, including exact namespaced skill matching.

### Changed

- Applied supported model, approval, service-tier, reasoning, summary, and personality settings to subsequent Codex turns without restarting Telex.
- Restarted only the child Codex app-server for startup-only changes, draining active turns while preserving authentication, conversation history, and persisted thread IDs.

### Fixed

- Fixed unexpected Codex app-server exits leaving active turns or RPC requests hanging, and made repeated start, stop, and failed-start recovery safe.
- Fixed unrelated sibling-file changes triggering config reloads and isolated MCP readiness tracking by thread and server.

## [0.0.7] - 2026-07-20

### Added

- Added persistent Telex settings and a Mini App toggle for connector-aware remote session context.
- Added Telegram channel direct-message topic routing and explicit support for generic message threads.
- Added `/start` to the Telegram command menu and help text, including command payload support.

### Fixed

- Fixed slash commands in forum and private-chat topics by parsing raw Telegram command entities before reply-context normalization.
- Fixed forum topic lifecycle service messages being forwarded to Codex as user turns.
- Fixed outbound text, rich messages, choices, and attachments losing their forum, generic-thread, or direct-message-topic destination.
- Fixed cached ephemeral command replies so they remain private and removed unsupported ephemeral command declarations.
- Fixed commands addressed to another bot being handled by Telex.

[0.0.24]: https://github.com/sadfun/telex/compare/v0.0.23...v0.0.24
[0.0.23]: https://github.com/sadfun/telex/compare/v0.0.22...v0.0.23
[0.0.22]: https://github.com/sadfun/telex/compare/v0.0.21...v0.0.22
[0.0.20]: https://github.com/sadfun/telex/compare/v0.0.19...v0.0.20
[0.0.17]: https://github.com/sadfun/telex/compare/v0.0.16...v0.0.17
[0.0.16]: https://github.com/sadfun/telex/compare/v0.0.15...v0.0.16
[0.0.15]: https://github.com/sadfun/telex/compare/v0.0.14...v0.0.15
[0.0.12]: https://github.com/sadfun/telex/compare/v0.0.11...v0.0.12
[0.0.8]: https://github.com/sadfun/telex/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/sadfun/telex/compare/v0.0.6...v0.0.7
