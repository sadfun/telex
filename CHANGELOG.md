# Changelog

All notable changes to Telex are documented in this file.

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

[0.0.7]: https://github.com/sadfun/telex/compare/v0.0.6...v0.0.7
