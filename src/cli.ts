#!/usr/bin/env node

import { Command, CommanderError } from 'commander';
import readline from 'node:readline';
import pkg from '../package.json';
import { formatCliError, resolveExitCode } from './errors';
import {
  installAction,
  updateAction,
  removeAction,
  editAction,
  defaultAction,
  listAction,
  showAction,
  cloneAction,
  runAction,
  wrapAction,
} from './commands';
import { runTuiApp } from './tui';

const program = new Command();
program.showSuggestionAfterError(true);
program.configureOutput({
  writeErr: () => {},
});

program
  .name('agenv')
  .description(
    'Environment manager for coding agents like codex, claude and gemini',
  )
  .version(pkg.version, '-v, --version')
  .option('--debug', 'Enable debug output (equivalent to AGENV_DEBUG=1)')
  .hook('preAction', (thisCommand) => {
    if (thisCommand.opts().debug) {
      process.env.AGENV_DEBUG = '1';
    }
  })
  .addHelpText(
    'after',
    `
Examples:
  $ agenv install codex                          # install codex (as profile named "codex")
  $ agenv install codex work                     # install codex into a profile named "work"
  $ agenv default local work                     # set \`agenv run\` to run "work" in this directory
  $ agenv default global work --for codex        # set \`agenv run codex\` to run "work" globally
  $ agenv edit local work --env FOO=bar          # configure a profile's env or args
  $ agenv run work                               # run by profile name
  $ agenv run                                    # run the resolved default (see \`agenv run --help\`)
  $ FOO=bar agenv run work                       # one-off env override

Run "agenv" for TUI (requires a TTY; AI agents should use the subcommands).
Run "agenv <command> --help" for detailed usage.
`,
  );

program
  .command('install')
  .alias('i')
  .description('Install an agent into a profile')
  .argument('<agent>', 'Agent name, e.g. codex, claude, gemini')
  .argument('[profile]', 'Profile name (default: same as agent)')
  .argument(
    '[savedArgs...]',
    'Default args saved for this profile (pass after "--")',
  )
  .option(
    '-e, --env <key=value>',
    'Set profile environment variable (repeatable)',
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option('-f, --force', 'Reinstall even if profile exists')
  .option('--env-file <path>', 'Load environment variables from a .env file')
  .option('--yolo', 'Add full-auto / skip-permissions args for the agent')
  .option('--pin <version>', 'Pin to a specific version (skips update prompts)')
  .addHelpText(
    'after',
    `

Notes:
  - Installs agent files under $AGENV_HOME/agents/<profile>/agent.
  - Saves --env and "-- <savedArgs...>" into global .agenv.json.
  - Does not launch the agent.
  - --yolo adds agent-specific auto-approve args to saved args:
      codex:  --full-auto
      claude: --dangerously-skip-permissions
      gemini: --yolo
  - --pin locks the profile to a specific version. Newer versions are
    shown as info during "agenv run" but never prompted for update.

Examples:
  $ agenv install codex
  $ agenv install codex work --yolo
  $ agenv install codex work -- --yolo            # save --yolo as default arg
  $ agenv install claude claude-pro
  $ agenv install codex work --env-file .env
  $ agenv install codex work --pin 0.1.2
`,
  )
  .action((agentSpec, profile, savedArgs, options) => {
    return wrapAction(installAction)(agentSpec, profile, savedArgs, options);
  });

program
  .command('update')
  .alias('up')
  .description('Update a profile to a new version')
  .argument('<profile>', 'Profile name, e.g. work')
  .option(
    '--pin <version>',
    'Target version. Pins the profile (skips update prompts during run).',
  )
  .addHelpText(
    'after',
    `

Notes:
  - Without --pin, "update" tracks latest: pulls the newest version
    and clears any existing pin (so future runs may prompt to update again).
  - With --pin, the profile is pinned to that version.

Examples:
  $ agenv update work                  # → latest, unpinned
  $ agenv update work --pin 0.1.2      # → 0.1.2, pinned
`,
  )
  .action(wrapAction(updateAction));

program
  .command('remove')
  .alias('rm')
  .description('Remove a profile and installed files')
  .argument('<profile>', 'Profile name')
  .action(wrapAction(removeAction));

program
  .command('edit')
  .description("Edit a profile's args or env (scope: local or global)")
  .argument('[scope]', 'Config scope: "local" or "global"')
  .argument('[profile]', 'Profile name')
  .argument(
    '[savedArgs...]',
    'Default args saved for this profile (pass after "--")',
  )
  .option(
    '-e, --env <key=value>',
    'Set profile environment variable (repeatable)',
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option('--env-file <path>', 'Load environment variables from a .env file')
  .addHelpText(
    'after',
    `

Notes:
  - "local" writes to .agenv.json in the current directory (created if needed).
  - "global" writes to $AGENV_HOME/.agenv.json.
  - Local config overrides global config:
      args: project value fully replaces global args (no flag-level merge —
            agenv does not parse args, so it treats the string as opaque).
      env:  per-key merge, project value wins on conflict.
  - To set a profile as a default, use \`agenv default\` instead.

Examples:
  $ agenv edit global work --env FOO=BAR          # set env var globally
  $ agenv edit global work -- --model gpt-5       # set saved args globally
  $ agenv edit local work --env FOO=BAR           # set env var for this project
  $ agenv edit local work --env-file .env         # bulk-load env from a .env file
`,
  )
  .action((scope, profile, savedArgs, options) => {
    return wrapAction(editAction)(scope, profile, savedArgs, options);
  });

program
  .command('default')
  .description('Set a profile as a local or global default')
  .argument('[scope]', 'Config scope: "local" or "global"')
  .argument('[profile]', 'Profile name to claim the default for')
  .option(
    '--for <agent>',
    'Claim the agent-specific default (e.g. --for codex). Without --for, claims the overall default.',
  )
  .addHelpText(
    'after',
    `

Notes:
  - "local" writes to .agenv.json in the current directory (created if needed).
  - "global" writes to $AGENV_HOME/.agenv.json.
  - Local config overrides global config when both set the same default.
  - This command is claim-only: it sets a default but never clears one. To
    change, claim a different profile. To clear all defaults for a profile,
    remove the profile with \`agenv remove\`.

Examples:
  $ agenv default local work                # set work as this project's default
  $ agenv default global work               # set work as the global default
  $ agenv default local work --for codex    # set work as project's codex default
  $ agenv default global work --for claude  # set work as global claude default
`,
  )
  .action(wrapAction(defaultAction));

program
  .command('list')
  .alias('ls')
  .description('List installed profiles')
  .option('--json', 'Output JSON')
  .addHelpText(
    'after',
    `

The "default" column shows what each profile is currently selected for in this
directory. Tags: an agent name (e.g. "codex") means \`agenv run <agent>\`
resolves to this profile; "default" means \`agenv run\` (no args) resolves to it.

Examples:
  $ agenv list
  $ agenv list --json
`,
  )
  .action(wrapAction(listAction));

program
  .command('show')
  .description('Show profile details')
  .argument('[profile]', 'Profile name')
  .option('--json', 'Output JSON')
  .option(
    '--reveal',
    'Show env values for secret-shaped keys (KEY/TOKEN/SECRET/PASSWORD); redacted by default',
  )
  .addHelpText(
    'after',
    `

Notes:
  - Env values whose keys match *KEY/*TOKEN/*SECRET/*PASSWORD/*CREDENTIAL are
    redacted as "***" by default. Pass --reveal to show them. Other env values
    are shown as-is.

Examples:
  $ agenv show work
  $ agenv show work --json
  $ agenv show work --reveal
`,
  )
  .action(wrapAction(showAction));

program
  .command('run')
  .description('Run an installed profile')
  .argument('[selector]', 'Profile name or agent name')
  .argument('[profileArgs...]', 'Arguments forwarded to the profile agent')
  .option('--profile <profile>', 'Run by explicit profile name')
  .option(
    '--agent <agent>',
    'Run by explicit agent name: codex | claude | gemini',
  )
  .option('--tui', 'Select a profile via interactive TUI')
  .option(
    '--debug',
    'Show selector/config resolution trace + stack traces + update-check warnings (equivalent to AGENV_DEBUG=1)',
  )
  .option(
    '--dry-run',
    'Preview resolved profile, args, and env without running',
  )
  .option('--yolo', 'Add full-auto / skip-permissions args for this run only')
  .option(
    '-e, --env <key=value>',
    'Per-run environment variable override (repeatable). Wins over profile env and shell env.',
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option('--no-update-check', 'Skip the pre-launch update check')
  .addHelpText(
    'after',
    `

Selector Resolution:
  Config precedence: nearest project .agenv.json -> global .agenv.json
  - \`agenv run\`                     -> resolved default profile
  - \`agenv run <agent>\`             -> agent selector (codex|claude|gemini)
  - \`agenv run <profile>\`           -> profile selector
  - \`agenv run --profile <profile>\` -> explicit profile selector
  - \`agenv run --agent <agent>\`     -> explicit agent selector

  --profile and --agent cannot be used together.
  A positional selector cannot be combined with --profile/--agent.

  --yolo is translated to agent-specific auto-approve args:
    codex: --full-auto, claude: --dangerously-skip-permissions, gemini: --yolo

Environment precedence (low to high):
  1. shell env (\`process.env\`, including any \`FOO=bar agenv run\` prefix)
  2. profile env (project merged over global) — overrides shell per-key
  3. \`--env KEY=VALUE\` — overrides profile env for this run only
  4. agenv-injected (\`AGENV_PROFILE\`, \`CODEX_HOME\`/\`CLAUDE_CONFIG_DIR\`/
     \`GEMINI_CLI_HOME\`) — always wins

  Note: a globally-exported shell var like \`OPENAI_API_KEY\` does NOT win over
  a profile env entry. Use \`--env\` to override per-run.

Examples:
  $ agenv run                              # resolve default profile
  $ agenv run work                         # run by profile name
  $ agenv run codex                        # run by agent name
  $ agenv run work --yolo                  # run with auto-approve args
  $ agenv run work --env OPENAI_API_KEY=sk-temp   # one-off env override
  $ agenv run --agent codex -- --version   # explicit agent, forwarded args
  $ agenv run codex --debug --dry-run      # preview resolution
`,
  )
  .action(wrapAction(runAction));

program
  .command('clone')
  .description('Clone an existing profile into a new one')
  .argument('<source>', 'Source profile name')
  .argument('<target>', 'New profile name')
  .addHelpText(
    'after',
    `

Notes:
  - Copies agent installation and profile settings (args, env).
  - Keeps the source profile version and pin state.
  - The clone gets its own isolated config directory.

Examples:
  $ agenv clone work work-experimental
`,
  )
  .action(wrapAction(cloneAction));

for (const command of program.commands) {
  command.showSuggestionAfterError(true);
  command.exitOverride();
}

async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolve(v === '' || v === 'y' || v === 'yes');
    });
  });
}

async function runInteractiveTui() {
  const result = await runTuiApp();
  if (result.action === 'exit') return;
  if (result.action === 'run') {
    await wrapAction(runAction)(result.profile, [], {});
    return;
  }
  if (result.action === 'install') {
    const { wizard } = result;
    await wrapAction(installAction)(wizard.agent, wizard.profile, [], {
      yolo: wizard.yolo,
    });
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const runNow = await promptYesNo(
        `\nRun profile "${wizard.profile}" now? [Y/n] `,
      );
      if (runNow) {
        await wrapAction(runAction)(wizard.profile, [], {});
      }
    }
  }
}

program.exitOverride();

(async () => {
  try {
    if (process.argv.length <= 2) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await runInteractiveTui();
        return;
      }
      program.outputHelp();
      return;
    }
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError && err.exitCode === 0) {
      // --help, --version, etc. — commander throws but means success.
      process.exit(0);
    }
    const formatted = formatCliError(err, {
      argv: process.argv,
    });
    console.error(`Error: ${formatted}`);
    if (process.env.AGENV_DEBUG) {
      console.error(err);
    }
    process.exit(resolveExitCode(err));
  }
})();
