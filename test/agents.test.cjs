const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseArgsString,
  normalizeAgentName,
  normalizeProfileName,
  assertValidProfileName,
  assertSupportedAgent,
  shellEscapeArg,
  stringifyArgs,
} = require('../dist/agents');

test('parseArgsString: empty/null input', () => {
  assert.deepEqual(parseArgsString(null), []);
  assert.deepEqual(parseArgsString(undefined), []);
  assert.deepEqual(parseArgsString(''), []);
  assert.deepEqual(parseArgsString('   '), []);
});

test('parseArgsString: simple args', () => {
  assert.deepEqual(parseArgsString('--foo bar'), ['--foo', 'bar']);
  assert.deepEqual(parseArgsString('a b c'), ['a', 'b', 'c']);
  assert.deepEqual(parseArgsString('  a  b  '), ['a', 'b']);
});

test('parseArgsString: single-quoted args', () => {
  assert.deepEqual(parseArgsString("'hello world'"), ['hello world']);
  assert.deepEqual(parseArgsString("--flag 'a b c'"), ['--flag', 'a b c']);
});

test('parseArgsString: double-quoted args', () => {
  assert.deepEqual(parseArgsString('"hello world"'), ['hello world']);
  assert.deepEqual(parseArgsString('"escaped \\"quote"'), ['escaped "quote']);
  assert.deepEqual(parseArgsString('"escaped \\\\backslash"'), [
    'escaped \\backslash',
  ]);
});

test('parseArgsString: backslash escaping outside quotes', () => {
  assert.deepEqual(parseArgsString('hello\\ world'), ['hello world']);
  assert.deepEqual(parseArgsString('a\\\\b'), ['a\\b']);
});

test('parseArgsString: unterminated quote throws', () => {
  assert.throws(() => parseArgsString('"unterminated'), /unterminated/);
  assert.throws(() => parseArgsString("'unterminated"), /unterminated/);
});

test('normalizeAgentName', () => {
  assert.equal(normalizeAgentName('CODEX'), 'codex');
  assert.equal(normalizeAgentName('  Claude  '), 'claude');
  assert.equal(normalizeAgentName(null), '');
  assert.equal(normalizeAgentName(undefined), '');
});

test('normalizeProfileName', () => {
  assert.equal(normalizeProfileName('Work'), 'work');
  assert.equal(normalizeProfileName('  my-profile  '), 'my-profile');
  assert.equal(normalizeProfileName(null), '');
});

test('assertValidProfileName: valid names', () => {
  assert.doesNotThrow(() => assertValidProfileName('work'));
  assert.doesNotThrow(() => assertValidProfileName('my-profile'));
  assert.doesNotThrow(() => assertValidProfileName('profile_1'));
  assert.doesNotThrow(() => assertValidProfileName('a'));
});

test('assertValidProfileName: invalid names', () => {
  assert.throws(() => assertValidProfileName(''), /required/);
  assert.throws(() => assertValidProfileName('foo@bar'), /@/);
  assert.throws(() => assertValidProfileName('-invalid'), /lowercase/);
  assert.throws(() => assertValidProfileName('_invalid'), /lowercase/);
  assert.throws(() => assertValidProfileName('UPPER'), /lowercase/);
});

test('assertSupportedAgent: valid agents', () => {
  assert.doesNotThrow(() => assertSupportedAgent('codex'));
  assert.doesNotThrow(() => assertSupportedAgent('claude'));
  assert.doesNotThrow(() => assertSupportedAgent('gemini'));
});

test('assertSupportedAgent: invalid agent', () => {
  assert.throws(() => assertSupportedAgent('gpt'), /Unsupported agent/);
});

test('shellEscapeArg: safe args pass through', () => {
  assert.equal(shellEscapeArg('hello'), 'hello');
  assert.equal(shellEscapeArg('--flag'), '--flag');
  assert.equal(shellEscapeArg('./path/to/file'), './path/to/file');
});

test('shellEscapeArg: unsafe args get quoted', () => {
  assert.equal(shellEscapeArg('hello world'), "'hello world'");
  assert.equal(shellEscapeArg("it's"), "'it'\"'\"'s'");
});

test('stringifyArgs', () => {
  assert.equal(stringifyArgs([]), '');
  assert.equal(stringifyArgs(null), '');
  assert.equal(stringifyArgs(['--foo', 'bar']), '--foo bar');
  assert.equal(stringifyArgs(['hello world']), "'hello world'");
});
