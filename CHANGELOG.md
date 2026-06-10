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

### Changed

- codex `--yolo` now appends `--yolo` instead of the removed `--full-auto`
  flag.
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
