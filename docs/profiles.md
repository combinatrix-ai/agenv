# Profiles Specification

This document defines the current profile/config model used by `agenv`.

## Storage Layout

### `AGENV_HOME`

Default: `~/.agenv` (or `$AGENV_HOME` when set).

- `AGENV_HOME/.agenv.json`
  - Global defaults config (same schema as project config).
- `AGENV_HOME/agents/<profile>/agent/`
  - Installed agent files for the profile.
- `AGENV_HOME/agents/<profile>/config/`
  - Agent home/config directory for the profile.
- `AGENV_HOME/agents/<profile>/profile.json`
  - Profile metadata/settings owned by that profile.

## Supported Agents

| Agent    | Package                     | Home env var        | `--yolo` adds                    |
|----------|-----------------------------|---------------------|----------------------------------|
| `codex`  | `@openai/codex`             | `CODEX_HOME`        | `--yolo`                         |
| `claude` | `@anthropic-ai/claude-code` | `CLAUDE_CONFIG_DIR` | `--dangerously-skip-permissions` |
| `gemini` | `@google/gemini-cli`        | `GEMINI_CLI_HOME`   | `--yolo`                         |

Before launching, `agenv` points the agent's home env var at the profile's config directory (`AGENV_HOME/agents/<profile>/config/`).

## Config Files

Use the same JSON structure for both:

- local (project): `<project>/.agenv.json`
- global: `AGENV_HOME/.agenv.json`

Config files are schema-validated. Unknown properties, uppercase profile selectors, unsupported agent keys, and non-string env values are rejected.

### Schema

```json
{
  "defaultProfile": "work",
  "agentDefaults": {
    "codex": "work",
    "claude": "private"
  },
  "profiles": {
    "work": {
      "args": "--model gpt-5",
      "env": {
        "FOO": "bar"
      }
    }
  }
}
```

### Field meanings

- `defaultProfile`: default profile used for `agenv run` (no selector).
- `agentDefaults`: per-agent default profile mapping.
- `profiles.<name>.args`: default CLI args for that profile in this scope.
- `profiles.<name>.env`: default environment variables for that profile in this scope.

## Profile Metadata (`profile.json`)

Each profile directory has a metadata file:

`AGENV_HOME/agents/<profile>/profile.json`

Fields:

```json
{
  "profile": "work",
  "agent": "codex",
  "package": "@openai/codex",
  "version": "latest",
  "pinned": false,
  "installedAt": "2025-06-01T12:00:00.000Z",
  "profilePath": "/Users/me/.agenv/agents/work",
  "agentPath": "/Users/me/.agenv/agents/work/agent",
  "configPath": "/Users/me/.agenv/agents/work/config"
}
```

Notes:

- `pinned`: true when installed or updated with `--pin`; pinned profiles do not prompt to auto-update during `agenv run`.
- `installedAt`: ISO 8601 timestamp recorded at install time. Used for deterministic ordering (oldest-first) when multiple profiles match a selector.
- `profilePath` / `agentPath` / `configPath`: stored for the installed profile.
- `args` / `env` are not stored in `profile.json`.
- `args` / `env` are stored in config files (`profiles.<name>.args` / `profiles.<name>.env`).
- Deleting `AGENV_HOME/agents/<profile>/` removes the profile agent/config/meta together.

## Resolution Order

When resolving runtime config for the current working directory:

1. Nearest project `.agenv.json` (walk upward and stop at the first match).
2. `AGENV_HOME/.agenv.json` as the global fallback (lowest priority).

## Merge Semantics

For values applied from global -> project:

- `defaultProfile`: project value wins when set.
- `agentDefaults[agent]`: project value wins when set.
- `profiles.<name>.args`: **whole-string replace**. If project sets `args`,
  the global `args` for that profile is discarded entirely (no token-level
  merging). agenv does not parse `args` and treats it as an opaque string,
  so it cannot merge flag-by-flag. To layer flags, copy the global value
  into the project entry and extend it.
- `profiles.<name>.env`: key-wise merge, project value wins on conflict.

### Worked example

Global (`~/.agenv/.agenv.json`):

```json
{
  "defaultProfile": "work",
  "profiles": {
    "work": {
      "args": "--model gpt-5",
      "env": { "APP_FLAG": "g", "DEBUG": "1" }
    }
  }
}
```

Project (`./.agenv.json`):

```json
{
  "profiles": {
    "work": {
      "args": "--temperature 0.9",
      "env": { "APP_FLAG": "l" }
    }
  }
}
```

Resolved view of the `work` profile in this directory:

- `defaultProfile` → `"work"` (only set in global; project does not override)
- `args` → `"--temperature 0.9"` (project value fully replaces global; `--model gpt-5` is dropped)
- `env` → `{ APP_FLAG: "l", DEBUG: "1" }` (per-key merge; project wins on `APP_FLAG`, global `DEBUG` carries through)

If the user's shell exports `APP_FLAG=shell`, the spawned agent still receives `APP_FLAG=l` — profile env wins over shell env (see below).

## CLI Args Composition

Final args passed to the agent are concatenated in this order:

1. resolved saved args from config (project value wins over global),
2. agent-specific yolo args (when `agenv run --yolo` is used),
3. explicit args passed after `agenv run ... -- <args>`.

Args are composed, not overridden — if the agent CLI sees a flag twice
(e.g. `--model gpt-4 --model gpt-5`), agent-specific behavior decides which
wins (typically the last one).

## Run-time Environment Precedence

The environment passed to the spawned agent is layered (low to high):

1. **Shell env** (`process.env`) is applied first, including any `FOO=bar agenv run` prefix and globally-exported vars from `.zshrc` / `.bashrc`.
2. **Profile env** (project-merged-over-global) overrides shell env per-key. Profile env is authoritative — that is the point of an agenv profile, so a profile-set `OPENAI_API_KEY` always wins over an exported one.
3. **`agenv run --env KEY=VALUE`** (repeatable) overrides profile env for this run only.
4. **Auto-injection** (`AGENV_PROFILE`, agent config-dir vars such as `CODEX_HOME`/`CLAUDE_CONFIG_DIR`/`GEMINI_CLI_HOME`) is applied last and cannot be overridden by anything else.

This ordering preserves isolation: a globally-exported env var cannot silently leak into a profile that explicitly set its own value. The Unix idiom `KEY=VALUE agenv run` still works for any key the profile does not set; for keys the profile does set, use `agenv run --env KEY=VALUE` to override per-run.

## Automatic repair of global defaults

`agenv` keeps the **global** config self-consistent with what is actually installed on disk. This runs on `install`, `remove`, and at the start of any command that resolves config (e.g. `run`, `list`, `show`).

Rules:

- If `defaultProfile` is unset, or points to a profile that is no longer installed, it is set to the **oldest installed profile** (by `installedAt`, ties broken by name).
- For each supported agent, `agentDefaults[agent]` is set to the oldest installed profile **for that agent** if it is unset, points to a missing profile, or points to a profile whose agent does not match.
- If no profile for that agent exists, `agentDefaults[agent]` is removed.
- When no profiles are installed at all, `defaultProfile` and `agentDefaults` are cleared.

Healing is applied silently to **global** config only. Project (`.agenv.json`) values are never auto-rewritten or silently ignored — `agenv run` errors out when the project selector it would actually use points to a missing profile (or, for `agentDefaults[agent]`, the wrong agent). The error names the file and suggests `agenv default local <other>`, installing the missing profile, `agenv run --profile <other>`, or editing the file directly. Unrelated invalid selectors do not block other resolution paths; read the project `.agenv.json` directly to inspect them.
