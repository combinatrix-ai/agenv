import { createUserError } from './errors';

const SUPPORTED_AGENTS: Set<string> = new Set(['codex', 'claude', 'gemini']);

const DEFAULT_PACKAGES: Record<string, string> = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  gemini: '@google/gemini-cli',
};

function normalizeAgentName(name: string | null | undefined) {
  return (name || '').trim().toLowerCase();
}

function assertSupportedAgent(name: string) {
  if (!SUPPORTED_AGENTS.has(name)) {
    throw createUserError(
      `Unsupported agent "${name}". Choose one of:
  codex    - OpenAI Codex (@openai/codex)
  claude   - Anthropic Claude Code (@anthropic-ai/claude-code)
  gemini   - Google Gemini CLI (@google/gemini-cli)`,
    );
  }
}

function resolvePackageName(name: string, statePackage?: string) {
  if (statePackage) return statePackage;
  const builtin = DEFAULT_PACKAGES[name];
  if (builtin) return builtin;
  throw createUserError(`No npm package configured for agent "${name}".`);
}

function normalizeProfileName(name: string | null | undefined) {
  return (name || '').trim().toLowerCase();
}

function assertValidProfileName(name: string) {
  if (!name) {
    throw createUserError('Profile name is required.');
  }
  if (name.includes('@')) {
    throw createUserError(`Invalid profile "${name}". "@" is not allowed.`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw createUserError(
      `Invalid profile "${name}". Use lowercase letters, numbers, "-" or "_".
Examples: work, claude-pro, my_codex_1`,
    );
  }
}

function envVarForAgent(name: string) {
  if (name === 'codex') return 'CODEX_HOME';
  if (name === 'claude') return 'CLAUDE_CONFIG_DIR';
  if (name === 'gemini') return 'GEMINI_CLI_HOME';
  return null;
}

// Agent-specific default environment values applied during install.
const DEFAULT_ENV: Record<string, Record<string, string>> = {};

const YOLO_ARGS: Record<string, string[]> = {
  codex: ['--yolo'],
  claude: ['--dangerously-skip-permissions'],
  gemini: ['--yolo'],
};

const AUTO_MODE_ARGS: Record<string, string[]> = {
  codex: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
  claude: ['--enable-auto-mode'],
};

function getYoloArgs(agent: string): string[] {
  const args = YOLO_ARGS[agent];
  if (!args) {
    throw createUserError(`No yolo args defined for agent "${agent}".`);
  }
  return args;
}

function getAutoModeArgs(agent: string): string[] {
  const args = AUTO_MODE_ARGS[agent];
  if (!args) {
    throw createUserError(
      `--auto-mode is not supported for agent "${agent}". Supported: ${Object.keys(AUTO_MODE_ARGS).join(', ')}.`,
    );
  }
  return args;
}

function parseArgsString(argString: string | null | undefined) {
  if (!argString || typeof argString !== 'string') return [];
  const args: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < argString.length; i += 1) {
    const ch = argString[i];

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '\\') {
        const next = argString[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i += 1;
          continue;
        }
      }
      current += ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === '\\') {
      const next = argString[i + 1];
      if (
        next &&
        (/\s/.test(next) || next === '"' || next === "'" || next === '\\')
      ) {
        current += next;
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }

    current += ch;
  }

  if (quote) {
    throw createUserError(
      `Invalid args: unterminated ${quote} quote in "${argString}"`,
    );
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function shellEscapeArg(arg: string) {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) {
    return arg;
  }
  return `'${String(arg).replace(/'/g, "'\"'\"'")}'`;
}

function stringifyArgs(args: string[] | null | undefined) {
  if (!Array.isArray(args) || !args.length) return '';
  return args.map(shellEscapeArg).join(' ');
}

export {
  SUPPORTED_AGENTS,
  DEFAULT_PACKAGES,
  DEFAULT_ENV,
  normalizeAgentName,
  normalizeProfileName,
  assertSupportedAgent,
  assertValidProfileName,
  envVarForAgent,
  getYoloArgs,
  getAutoModeArgs,
  resolvePackageName,
  parseArgsString,
  shellEscapeArg,
  stringifyArgs,
};
