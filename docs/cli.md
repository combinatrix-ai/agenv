# CLI Reference

This document describes the current `agenv` CLI behavior.

## Command Summary

```bash
agenv install <agent> [profile] [--env KEY=VALUE] [--env-file <path>] [--yolo] [--pin <version>] [--force] [-- <saved_args...>]
agenv update <profile> [--pin <version>]
agenv remove <profile>
agenv default <local|global> <profile> [--for <agent>]
agenv edit <local|global> <profile> [--env KEY=VALUE] [--env-file <path>] [-- <saved_args...>]
agenv list [--json]
agenv show [profile] [--json] [--reveal]
agenv run [selector] [--profile <profile> | --agent <agent>] [--tui] [--yolo] [--env KEY=VALUE] [--debug] [--dry-run] [--no-update-check] [-- <agent_args...>]
agenv clone <source> <target>
```

## Profile Name Rules

Profile names are normalized to lowercase and must match `^[a-z0-9][a-z0-9_-]*$`.

## Config Resolution

`agenv` loads at most one project config: the nearest `.agenv.json` found by walking up from the current working directory. It merges that over the global config at `$AGENV_HOME/.agenv.json` (or `~/.agenv/.agenv.json` when `AGENV_HOME` is not set).

Values are applied from global -> project (project wins).

- `defaultProfile`: project value wins when set.
- `agentDefaults[agent]`: project value wins when set.
- `profiles.<name>.args`: project value wins when set.
- `profiles.<name>.env`: merged by key, project wins.

Local write commands (`agenv edit local ...`, `agenv default local ...`) always write `.agenv.json` in the current working directory. They do not edit a parent config discovered during resolution.

## Command Details

### `--` Semantics

- `install ... -- <saved_args...>`: save default args to global config.
- `edit global ... -- <saved_args...>`: save default args to global config.
- `edit local ... -- <saved_args...>`: save default args to local config.
- `run ... -- <agent_args...>`: pass runtime-only args to the agent process.
- `default` does not accept `--`; use `agenv edit` for args/env.

### `install`

Install an agent into a profile.

Required:

- `<agent>`: Agent name, e.g. `codex`, `claude`, `gemini`

Optional positional:

- `[profile]`: Profile name. Defaults to the agent name.

Options:

- `--env KEY=VALUE` (repeatable): stores env defaults in global config under that profile
- `--env-file <path>`: load env defaults from a dotenv-style file
- `--yolo`: add agent-specific auto-approve flags (`--yolo` for codex, `--dangerously-skip-permissions` for claude, `--yolo` for gemini)
- `--pin <version>`: pin to a specific version (skips update prompts during `run`)
- `--force`: reinstall even if profile exists
- `-- <saved_args...>`: saves default args in global config under that profile

Behavior notes:

- If profile exists and `--force` is not given, install is skipped.
- When install succeeds, `agenv` writes global profile settings for any `--env`, `--env-file`, `--yolo`, or saved args passed during install.

### `update`

Update an existing profile.

Options:

- `--pin <version>`: target concrete version. **Pins the profile**, so `agenv run` won't prompt to update past it.

Behavior:

- `agenv update <profile>` (no version flag) pulls latest, sets the profile to the resolved version, and **clears any existing pin** — the profile then tracks latest, and `agenv run` will offer to update again when a newer version appears.
- `agenv update <profile> --pin X` sets the profile to X and pins it. To clear a pin, run `agenv update <profile>` with no version flag.

### `remove`

Deletes the profile directory recursively.

### `default`

Claim a profile as the local or global default. Set-only — there is no command to clear a default directly; claim a different profile, or edit the JSON config if you need to remove the default entry. Removing a profile deletes the profile itself and may re-point *global* defaults automatically; see [Automatic repair of global defaults](./profiles.md#automatic-repair-of-global-defaults).

Required:

- `<scope>`: `local` or `global`
- `<profile>`: profile name to claim the default for

Options:

- `--for <agent>`: claim the agent-specific default (writes `agentDefaults.<agent>`). Without `--for`, claims the overall default (writes `defaultProfile`).

Notes:

- `global` writes to `$AGENV_HOME/.agenv.json`.
- `local` writes to `.agenv.json` in the current directory (created if needed, not nearest ancestor).
- Profile must be installed.
- For `--for`, the profile's agent must match the specified agent.

### `edit`

Edit `profiles.<name>` in the specified config scope (args/env only).

Required:

- `<scope>`: `local` or `global`
- `<profile>`: profile name

Options:

- `--env KEY=VALUE` (repeatable): set profile env
- `--env-file <path>`: load env from a dotenv-style file
- `-- <saved_args...>`: set saved default args

Notes:

- `global` writes to `$AGENV_HOME/.agenv.json`.
- `local` writes to `.agenv.json` in the current directory (created if needed, not nearest ancestor).
- Global and local edits require the profile to be installed.
- To set a profile as a default, use `agenv default` instead.
- There is no CLI flag to clear saved args or env keys; edit the JSON config directly if you need to remove values.

### `list`

List installed profiles. Aliased as `ls`.

Plain output is a table with a `default` column that shows what each profile is currently selected for in the current directory:

- the agent name (e.g. `codex`) means `agenv run <agent>` resolves to this profile
- `default` means `agenv run` (no selector) resolves to this profile
- `-` means neither selector resolves to this profile

A profile may carry both tags (`codex, default`) when it is the resolved default for its agent and the overall default. When a selector is unresolvable in the current directory (e.g. multiple profiles for an agent and no default set), no profile gets that tag.

Options:

- `--json`: JSON output object: `{ profiles }`

JSON output shape:

- `profiles`: array of profile metadata (`profile`, `agent`, `version`, `package`, paths, account, args, localArgs, `resolves`)
- `resolves`: array of selector tags that point at this profile (e.g. `["codex", "default"]`); same semantics as the plain table column

### `show`

Show details for a single profile.

Optional positional:

- `[profile]`: profile name. If omitted, `show` prints a help message listing available profiles instead of erroring opaquely.

Options:

- `--json`: JSON output
- `--reveal`: show env values for secret-shaped keys; without this, keys matching `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, or `CREDENTIAL` are redacted

Plain output includes installed metadata, account detection when available, project/global scoped settings, effective args/env keys for the current directory, and which `agenv run` selectors currently choose the profile.

JSON output includes the list fields plus `envRevealed`, `installedAt`, scoped project/global settings, shadowed global settings, and `selectedBy`. The `binPath` field gives the resolved executable path — pipe through `jq -r .binPath` when an external tool needs the binary directly.

### `run`

Runs the selected profile executable.

Options:

- `--profile <profile>`: explicit profile resolution
- `--agent <agent>`: explicit agent resolution (`codex` | `claude` | `gemini`)
- `--tui`: select a profile via interactive TUI
- `--yolo`: add agent-specific auto-approve flags for this run
- `--env KEY=VALUE` (repeatable): per-run env override; wins over both profile env and shell env, but not over auto-injection
- `--debug`: print detailed selector/config resolution
- `--dry-run`: preview resolved config without launching the agent
- `--no-update-check`: skip the agent package update check for this run

Selector behavior:

- no selector: uses resolved default profile
- selector is agent name (`codex`/`claude`/`gemini`): uses agent-specific resolution
- otherwise: treated as profile name

Agent selector resolution tries, in order: `agentDefaults[agent]`, `defaultProfile` if it points to a profile for that agent, and the single installed profile for that agent. If multiple profiles match and no default disambiguates them, `run` errors.

Conflict rules:

- `--profile` and `--agent` cannot be used together.
- positional selector cannot be combined with `--profile` or `--agent`.

Strict project selectors:

- `agenv run` errors out when the project (`.agenv.json`) selector it would actually use points to a missing profile (or, for `agentDefaults[agent]`, a profile of the wrong agent). The error names the project config path and suggests fixes (`agenv default local <other>`, `agenv install ...`, `agenv run --profile <other>`, or editing the file directly).
- Only the selector on the resolution path is checked. For example, an invalid `agentDefaults.gemini` does not break `agenv run codex`. To inspect project selectors that aren't currently in your way, read the project `.agenv.json` directly.
- Global defaults are different — they are auto-healed (re-pointed to the oldest installed profile, or removed if no candidate exists). See [docs/profiles.md](./profiles.md#automatic-repair-of-global-defaults).

Update prompt:

- Before launching, `agenv run` checks the npm registry for a newer version of the selected agent package and, if one exists for an unpinned profile, **prompts interactively** (`Update? [Y/n]`) to update before launch. Pinned profiles only print an info line. Skip the check entirely with `--no-update-check` or `AGENV_NO_UPDATE_CHECK=1`.

Final CLI args passed to the agent (concatenated, in this order):

1. resolved saved args from config (project wins over global)
2. agent yolo args when `--yolo` is used
3. runtime args passed after `agenv run ... -- <args>`

Environment precedence (low to high):

1. shell env (`process.env`) — base layer, includes any `FOO=bar agenv run` prefix and globally-exported vars
2. profile env (project-merged-over-global) — overrides shell per-key, so a profile-set `OPENAI_API_KEY` always wins over an exported one
3. `--env KEY=VALUE` from the `agenv run` command — overrides profile env for this run only
4. auto-injection — agenv overwrites these regardless of profile/shell/`--env`:
   - `CODEX_HOME` for `codex`
   - `CLAUDE_CONFIG_DIR` for `claude`
   - `GEMINI_CLI_HOME` for `gemini`
   - `AGENV_PROFILE` set to the resolved profile name

Rationale: profile env is authoritative because the whole point of an agenv profile is to isolate per-account credentials and config. A globally-exported `OPENAI_API_KEY` from `.zshrc` should not silently leak into a profile that explicitly set its own. For one-off overrides, use `--env`.

### `clone`

Clone an existing profile into a new one.

- Copies agent installation and profile settings (args, env).
- The clone gets its own isolated config directory.

## Update Check Behavior

Before most commands, `agenv` checks the npm registry for a newer `@combinatrix/agenv` release and prints a one-line notice on stderr when available. The notice points you at the package manager you used to install agenv (e.g. `npm install -g @combinatrix/agenv@latest`). agenv does **not** ship a `self-update` command, because the right update path depends on the install method (`npm`, `pnpm`, `yarn`, `bun`, `volta`, `npm link`, system package manager, etc.).

Disable the notice with:

- `AGENV_NO_SELF_UPDATE_CHECK=1`

`agenv run` also checks whether the selected agent package has a newer version before launching it. Skip that per-run agent check with either `--no-update-check` or `AGENV_NO_UPDATE_CHECK=1`.

## Interactive TUI

Running `agenv` with no arguments in a TTY launches an interactive TUI for picking a profile to run or installing a new one. In non-interactive contexts (no TTY on stdin/stdout) the bare invocation prints `--help` instead. To force the TUI from a command, use `agenv run --tui`.

## Error Handling and Exit Codes

- Command errors print `Error: <message>` and exit with code `1`.
- With `AGENV_DEBUG` set, stack/error objects are also printed, and otherwise-silent failures (e.g. `run`'s pre-launch update check) emit warnings.
