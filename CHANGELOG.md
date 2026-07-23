# Changelog

All notable changes to Telex are documented in this file.

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

[0.0.16]: https://github.com/sadfun/telex/compare/v0.0.15...v0.0.16
[0.0.15]: https://github.com/sadfun/telex/compare/v0.0.14...v0.0.15
[0.0.12]: https://github.com/sadfun/telex/compare/v0.0.11...v0.0.12
[0.0.8]: https://github.com/sadfun/telex/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/sadfun/telex/compare/v0.0.6...v0.0.7
