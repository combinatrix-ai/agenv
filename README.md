# agenv

Environment manager for AI coding agents — like `nvm` or `pyenv`, but for agent accounts, config, and saved runtime args.

`agenv` installs `codex`, `claude`, and `gemini` into isolated profiles and lets you pick which profile runs by default, globally or per project. Each profile has its own agent binary and its own agent home directory, so auth, MCP servers, permissions, and history never bleed across profiles.

<img width="1080" height="460" alt="Image" src="https://github.com/user-attachments/assets/0aef078c-ca1b-4dbf-ba97-14835d7863df" />

## Install

```bash
npm install -g @combinatrix/agenv
```

## Common Workflows

> [!TIP]
> `agenv` (no args) opens the TUI shown below, which covers daily use cases.

```bash
$ agenv
agenv — Agent Environment Manager
╭───────────────────────────────────────────────────────────────────────────────────────╮
│     Name            Agent             Args            Env             Default         │
│ 1 > claude-home     claude@2.1.119    —               —               claude          │
│ 2   codex-home      codex@0.125.0     --full-auto     —                               │
│ 3   codex-work †    codex@0.125.0     —               OPENAI_API_KEY  codex, default  │
│ 4   gemini-family   gemini@0.39.1     —               —               gemini          │
│     + Create new profile                                                              │
╰───────────────────────────────────────────────────────────────────────────────────────╯
† Project config at /path/to/project/.agenv.json overrides here — press d for detail
1-9 run; n new; e edit; x remove; d detail; q quit
```

### Install and run

```bash
agenv install claude     # installs claude into a profile named "claude"
agenv run                # launches it (single installed profile → auto-selected)
```

### Separate work and personal accounts

```bash
agenv install claude work
agenv install claude personal

agenv run work
agenv run personal
```

### Set a global / local default

```bash
agenv install gemini work
agenv default global work
agenv run  # → work
cd some/repo
agenv run  # → work

agenv install gemini personal
agenv default local personal     # writes ./.agenv.json
agenv run  # → personal
cd another/repo
agenv run  # → work
```

### Configure args and env on a profile

```bash
agenv edit global work --env HTTPS_PROXY=http://proxy:8080  # set env var
agenv edit global work -- --model gpt-5                     # set saved args
agenv edit local work --env-file .env                       # bulk-load from .env
```

When both `local` and `global` set values for the same profile:

- **env**: project entries override global entries with the same key; non-overlapping keys from both are kept
- **args**: project args fully replace global args (no merging)

```bash
agenv edit global work --env APP_FLAG=g --env DEBUG=1 -- --model gpt-5
agenv edit local  work --env APP_FLAG=l -- --temperature 0.9
agenv run work  # → env: APP_FLAG=l, DEBUG=1; args: --temperature 0.9
```

Env and args can also come from the shell, `agenv run --env`, runtime `--`, `--yolo`, and auto-injected ones. For the full precedence order, see [env precedence](./docs/profiles.md#run-time-environment-precedence) and [args composition](./docs/profiles.md#cli-args-composition) in `docs/profiles.md`.

### Use multiple agents

```bash
agenv install codex
agenv install gemini gemini-private
agenv install gemini gemini-work

agenv default global codex                       # overall default
agenv default global gemini-private --for gemini  # default for `agenv run gemini`

cd some/repo
agenv default local gemini-work --for gemini      # project-local override

agenv run         # → codex
agenv run gemini  # → gemini-work
cd another/repo
agenv run gemini  # → gemini-private
```

### Update or pin an agent version

`agenv run` checks the registry before launching and offers to update outdated agents interactively. Pin a profile to skip those prompts, or pass `--no-update-check` (or set `AGENV_NO_UPDATE_CHECK=1`) to skip the check entirely.

```bash
agenv install codex work --pin 0.1.2     # install pinned to version 0.1.2
agenv update work --pin 0.1.5            # move the pin to version 0.1.5
agenv update work                        # update to latest version and remove the pin
```

### Clone, remove

```bash
agenv clone work work-experimental       # copy install + saved args/env into a new isolated profile
agenv remove work-experimental           # delete the profile directory
```

### Updating agenv itself

When a newer agenv release is published, `agenv` prints a one-line notice on stderr before each command. Update with whichever package manager you used to install agenv (e.g. `npm install -g @combinatrix/agenv@latest`). Suppress the notice with `AGENV_NO_SELF_UPDATE_CHECK=1`.

## Supported Agents

| Agent    | Package                     | `--yolo` adds                    |
|----------|-----------------------------|----------------------------------|
| `codex`  | `@openai/codex`             | `--full-auto`                    |
| `claude` | `@anthropic-ai/claude-code` | `--dangerously-skip-permissions` |
| `gemini` | `@google/gemini-cli`        | `--yolo`                         |

Each agent has its own flag for bypassing approval / permission prompts. Pass `--yolo` to `agenv run` (or `agenv install`) and agenv appends the right flag for that agent — so you don't have to remember which one is which.

## CLI Reference

```bash
agenv install <agent> [profile] [options] [-- <saved_args...>]
agenv update  <profile> [--pin <v>]
agenv remove  <profile>
agenv clone   <source> <target>
agenv default <local|global> <profile> [--for <agent>]
agenv edit    <local|global> <profile> [options] [-- <saved_args...>]
agenv list    [--json]
agenv show    [profile] [--json] [--reveal]
agenv run     [selector] [--profile <p> | --agent <a>] [--tui] [--yolo] [--env KEY=VALUE] [--dry-run] [--debug] [--no-update-check] [-- <agent_args...>]
```

Aliases: `i` (install), `up` (update), `rm` (remove), `ls` (list).

Run `agenv <command> --help` for details on each command. The full reference lives in [the CLI docs](./docs/cli.md).

### Selector Resolution

`agenv run` picks a profile based on its argument:

| Command                         | Resolves to            |
|---------------------------------|------------------------|
| `agenv run`                     | default profile        |
| `agenv run <agent>`             | agent-specific default |
| `agenv run <profile>`           | named profile          |
| `agenv run --profile <profile>` | explicit profile       |
| `agenv run --agent <agent>`     | explicit agent default |

Tiebreakers:

- `agenv run` (no selector): if no `defaultProfile` is set, use the sole installed profile when exactly one exists.
- `agenv run <agent>`: try `agentDefaults.<agent>`, then `defaultProfile` (only if it points to a profile of that agent), then the sole installed profile of that agent. Otherwise error.

Defaults are read from the nearest `.agenv.json` walking up from the cwd, falling back to `$AGENV_HOME/.agenv.json`.

### Inspect a Profile

```bash
agenv show work
agenv show work --json
agenv show work --reveal
```

`agenv show` redacts env values for secret-shaped keys. Use `--reveal` to print them.

### Diagnose

```bash
agenv ls                          # the `default` column shows what `agenv run` and `agenv run <agent>` resolve to here
agenv run --dry-run               # print resolved profile, args, env without launching
agenv run --debug                 # debug mode: resolution trace + error stack traces + update-check warnings
AGENV_DEBUG=1 agenv run work      # equivalent to --debug
```

## Storage

```text
~/.agenv/
├── .agenv.json
└── agents/
    ├── work/
    │   ├── agent/
    │   ├── config/
    │   └── profile.json
    └── personal/
        ├── agent/
        ├── config/
        └── profile.json
```

Override the root with `$AGENV_HOME`.

### Example `.agenv.json`

```json
{
  "defaultProfile": "work",
  "agentDefaults": {
    "codex": "work"
  },
  "profiles": {
    "work": {
      "args": "--model gpt-5",
      "env": {
        "DEBUG": "1"
      }
    }
  }
}
```

## More Details

- [CLI behavior](./docs/cli.md)
- [Config model](./docs/profiles.md)
