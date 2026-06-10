const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CliUserError,
  createUserError,
  errorSummary,
  formatCliError,
  isENOENT,
  resolveExitCode,
} = require('../dist/errors');

// CliUserError / createUserError

test('CliUserError: defaults', () => {
  const err = new CliUserError('boom');
  assert.equal(err.summary, 'boom');
  assert.equal(err.message, 'boom');
  assert.equal(err.exitCode, 1);
  assert.equal(err.seeCommand, undefined);
  assert.ok(err instanceof Error);
});

test('createUserError: returns CliUserError with options', () => {
  const err = createUserError('bad input', {
    seeCommand: 'install',
    exitCode: 2,
  });
  assert.ok(err instanceof CliUserError);
  assert.equal(err.summary, 'bad input');
  assert.equal(err.seeCommand, 'install');
  assert.equal(err.exitCode, 2);
});

// errorSummary

test('errorSummary: CliUserError returns summary', () => {
  assert.equal(errorSummary(createUserError('user facing')), 'user facing');
});

test('errorSummary: plain Error returns first line of message', () => {
  assert.equal(errorSummary(new Error('line one\nline two')), 'line one');
});

test('errorSummary: string value passes through', () => {
  assert.equal(errorSummary('raw failure'), 'raw failure');
});

test('errorSummary: null/undefined fall back to Unknown error', () => {
  assert.equal(errorSummary(null), 'Unknown error');
  assert.equal(errorSummary(undefined), 'Unknown error');
});

// formatCliError

test('formatCliError: CliUserError with bare seeCommand gets agenv prefix', () => {
  const out = formatCliError(createUserError('Bad', { seeCommand: 'list' }));
  assert.equal(out, 'Bad\nSee: agenv list --help');
});

test('formatCliError: CliUserError with full seeCommand kept as-is', () => {
  const out = formatCliError(
    createUserError('Bad', { seeCommand: 'agenv list' }),
  );
  assert.equal(out, 'Bad\nSee: agenv list --help');
});

test('formatCliError: CliUserError without seeCommand has no See line', () => {
  assert.equal(formatCliError(createUserError('Bad')), 'Bad');
});

test('formatCliError: commander unknown command points at agenv help', () => {
  const err = Object.assign(new Error("error: unknown command 'wat'"), {
    code: 'commander.unknownCommand',
  });
  const out = formatCliError(err, { argv: ['node', 'cli', 'wat'] });
  assert.equal(out, "unknown command 'wat'\nSee: agenv --help");
});

test('formatCliError: missing --agent value gets a curated hint', () => {
  const err = Object.assign(
    new Error("error: option '-a, --agent <agent>' argument missing"),
    { code: 'commander.optionMissingArgument' },
  );
  const out = formatCliError(err, { argv: ['node', 'cli', 'run'] });
  assert.equal(
    out,
    'Missing value for --agent. Use one of: codex, claude, gemini.\nSee: agenv run --help',
  );
});

test('formatCliError: missing value for other options names the option', () => {
  const err = Object.assign(
    new Error("error: option '--env <KEY=VALUE>' argument missing"),
    { code: 'commander.optionMissingArgument' },
  );
  const out = formatCliError(err, { argv: ['node', 'cli', 'install'] });
  assert.equal(
    out,
    'Missing value for --env <KEY=VALUE>.\nSee: agenv install --help',
  );
});

test('formatCliError: missing required argument', () => {
  const err = Object.assign(
    new Error("error: missing required argument 'agent'"),
    { code: 'commander.missingArgument' },
  );
  const out = formatCliError(err, { argv: ['node', 'cli', 'install'] });
  assert.equal(
    out,
    'Missing required argument "agent".\nSee: agenv install --help',
  );
});

test('formatCliError: generic error infers help target from argv', () => {
  const out = formatCliError(new Error('boom'), {
    argv: ['node', 'cli', 'install'],
  });
  assert.equal(out, 'boom\nSee: agenv install --help');
});

test('formatCliError: flag-like first token falls back to agenv help', () => {
  const out = formatCliError(new Error('boom'), {
    argv: ['node', 'cli', '--verbose'],
  });
  assert.equal(out, 'boom\nSee: agenv --help');
});

test('formatCliError: message already containing See line is untouched', () => {
  const out = formatCliError(new Error('boom\nSee: agenv show --help'), {
    argv: ['node', 'cli', 'install'],
  });
  assert.equal(out, 'boom\nSee: agenv show --help');
});

// isENOENT

test('isENOENT: matches ENOENT-coded errors only', () => {
  assert.equal(
    isENOENT(Object.assign(new Error('x'), { code: 'ENOENT' })),
    true,
  );
  assert.equal(isENOENT({ code: 'ENOENT' }), true);
  assert.equal(isENOENT(new Error('x')), false);
  assert.equal(isENOENT({ code: 'EACCES' }), false);
  assert.equal(isENOENT(null), false);
  assert.equal(isENOENT('ENOENT'), false);
});

// resolveExitCode

test('resolveExitCode: uses numeric exitCode when present', () => {
  assert.equal(resolveExitCode(createUserError('x', { exitCode: 3 })), 3);
  assert.equal(resolveExitCode({ exitCode: 7 }), 7);
});

test('resolveExitCode: defaults to 1', () => {
  assert.equal(resolveExitCode(new Error('x')), 1);
  assert.equal(resolveExitCode(null), 1);
  assert.equal(resolveExitCode({ exitCode: 'oops' }), 1);
});
