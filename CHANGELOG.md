# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `--auto-mode` flag for `agenv install` and `agenv run`: agent-specific
  safer auto-approve flags (codex: `--sandbox workspace-write
  --ask-for-approval on-request`, claude: `--enable-auto-mode`). Mutually
  exclusive with `--yolo`.
- `engines` field declaring Node.js >= 22 (Node 20 reached end-of-life in
  April 2026).
- `--channel <npm|native>` on `agenv install`: opt-in native install channel
  for claude (SHA256-verified direct download of the standalone binary) and
  codex (official standalone installer scoped to the profile via
  `CODEX_HOME`/`CODEX_INSTALL_DIR`). Profile metadata records `channel` and
  `binPath`; `run` launches native binaries directly and skips the
  npm-registry update check; `update` and `clone` preserve the channel.

### Changed

- codex `--yolo` now appends `--yolo` instead of the removed `--full-auto`
  flag.
- claude `--auto-mode` now appends `--permission-mode auto` instead of
  `--enable-auto-mode`, which was removed in Claude Code v2.1.111.
- gemini now supports `--auto-mode` (appends `--approval-mode auto_edit`)
  instead of erroring.
- new installs seed agent env defaults: `DISABLE_AUTOUPDATER=1` for claude
  (agenv manages versions) and `GEMINI_FORCE_FILE_STORAGE=true` for gemini
  (keeps API keys in the profile dir instead of the shared OS keychain).
  Existing profiles are unaffected; add the variables with `agenv edit` or
  reinstall with `--force` to adopt them.
- Failed external commands (e.g. `npm install`) now surface as user-facing
  CLI errors instead of raw stack traces.

## [1.0.0] - 2026-04-27

### Added

- Initial release: profile-first environment manager for AI coding agents
  (codex, claude, gemini).
- Commands: `install`, `update`, `remove`, `clone`, `default`, `edit`,
  `list`, `show`, `run`.
- Per-profile isolated agent installs and config dirs under `$AGENV_HOME`.
- Global and project-level `.agenv.json` config with precedence resolution.
- Interactive TUI (`agenv run --tui`).
- Self-update notice and agent package update checks.

[Unreleased]: https://github.com/combinatrix-ai/agenv/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/combinatrix-ai/agenv/releases/tag/v1.0.0
