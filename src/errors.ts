type CliUserErrorOptions = {
  seeCommand?: string;
  exitCode?: number;
};

type ErrorLike = {
  message?: string;
  code?: string;
  exitCode?: number;
};

function errorLike(value: unknown): ErrorLike {
  if (value && typeof value === 'object') {
    return value as ErrorLike;
  }
  return {};
}

export class CliUserError extends Error {
  summary: string;
  seeCommand?: string;
  exitCode: number;

  constructor(
    summary: string,
    { seeCommand, exitCode = 1 }: CliUserErrorOptions = {},
  ) {
    super(summary);
    this.summary = summary;
    this.seeCommand = seeCommand;
    this.exitCode = exitCode;
  }
}

export function createUserError(
  message: string,
  { seeCommand, exitCode }: CliUserErrorOptions = {},
) {
  return new CliUserError(message, { seeCommand, exitCode });
}

export function errorSummary(err: unknown) {
  if (err instanceof CliUserError) {
    return err.summary;
  }
  const detail = errorLike(err).message;
  return String(detail || err || 'Unknown error').split('\n')[0];
}

function inferHelpTarget(argv = process.argv) {
  const token = argv[2];
  if (!token || token.startsWith('-')) return 'agenv';
  return `agenv ${token}`;
}

function isCommanderError(err: unknown) {
  const detail = errorLike(err);
  return (
    typeof detail.code === 'string' && detail.code.startsWith('commander.')
  );
}

function stripCommanderPrefix(message: unknown) {
  return String(message || '').replace(/^error:\s*/i, '');
}

function extractQuotedValue(message: string, pattern: RegExp) {
  const match = message.match(pattern);
  return match ? match[1] : null;
}

function normalizeCommanderError(err: unknown, argv = process.argv) {
  const detail = errorLike(err);
  const message = stripCommanderPrefix(detail.message);
  if (
    detail.code === 'commander.unknownCommand' ||
    /unknown command /i.test(message)
  ) {
    return {
      summary: message,
      seeTarget: 'agenv',
    };
  }

  if (detail.code === 'commander.optionMissingArgument') {
    const option = extractQuotedValue(
      message,
      /option ['"]([^'"]+)['"] argument missing/i,
    );
    if (option && /--agent\b/.test(option)) {
      return {
        summary:
          'Missing value for --agent. Use one of: codex, claude, gemini.',
        seeTarget: inferHelpTarget(argv),
      };
    }
    return {
      summary: option ? `Missing value for ${option}.` : message,
      seeTarget: inferHelpTarget(argv),
    };
  }

  if (detail.code === 'commander.missingMandatoryOptionValue') {
    const option = extractQuotedValue(
      message,
      /required option ['"]([^'"]+)['"] not specified/i,
    );
    return {
      summary: option ? `Missing required option "${option}".` : message,
      seeTarget: inferHelpTarget(argv),
    };
  }

  if (detail.code === 'commander.missingArgument') {
    const argument = extractQuotedValue(
      message,
      /missing required argument ['"]([^'"]+)['"]/i,
    );
    return {
      summary: argument ? `Missing required argument "${argument}".` : message,
      seeTarget: inferHelpTarget(argv),
    };
  }

  return {
    summary: message,
    seeTarget: inferHelpTarget(argv),
  };
}

function normalizeSeeTarget(seeCommand?: string) {
  if (!seeCommand) return null;
  if (seeCommand === 'agenv' || seeCommand.startsWith('agenv ')) {
    return seeCommand;
  }
  return `agenv ${seeCommand}`;
}

export function formatCliError(
  err: unknown,
  { argv = process.argv }: { argv?: string[] } = {},
) {
  let summary = String(errorLike(err).message || err || 'Unknown error');
  let seeTarget = null;

  if (err instanceof CliUserError) {
    summary = err.summary;
    seeTarget = normalizeSeeTarget(err.seeCommand);
  } else if (isCommanderError(err)) {
    const normalized = normalizeCommanderError(err, argv);
    summary = normalized.summary;
    seeTarget = normalized.seeTarget;
  } else {
    if (!summary.includes('\nSee:')) {
      seeTarget = inferHelpTarget(argv);
    }
  }

  if (!seeTarget || summary.includes('\nSee:')) {
    return summary;
  }
  return `${summary}\nSee: ${seeTarget} --help`;
}

export function isENOENT(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function resolveExitCode(err: unknown) {
  const detail = errorLike(err);
  if (typeof detail.exitCode === 'number') {
    return detail.exitCode;
  }
  return 1;
}
