const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(__dirname, '..', 'dist', 'cli.js');

const {
  ensureInstalled,
  findAgentBinary,
  runCommand,
} = require('../dist/install');
const { CliUserError } = require('../dist/errors');

async function makeTempDir(t, prefix) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A fake `npm` placed first on PATH so ensureInstalled never hits the network.
// It simulates `npm install --prefix <dir> ... <name>@<version>` by writing
// node_modules/<name>/package.json under the prefix.
const FAKE_NPM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.FAKE_NPM_MODE === 'fail') process.exit(1);
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args[args.length - 1];
const at = spec.lastIndexOf('@');
const name = spec.slice(0, at);
const version = process.env.FAKE_NPM_RESOLVED || spec.slice(at + 1);
const pkgDir = path.join(prefix, 'node_modules', name);
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(
  path.join(pkgDir, 'package.json'),
  JSON.stringify({ name, version }) + '\\n',
);
`;

async function withFakeNpm(t, env = {}) {
  const binDir = await makeTempDir(t, 'agenv-fake-npm-');
  const npmPath = path.join(binDir, 'npm');
  await fs.writeFile(npmPath, FAKE_NPM, { mode: 0o755 });
  const saved = {};
  const overrides = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ...env,
  };
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function withTempAgenvHome(t) {
  const home = await makeTempDir(t, 'agenv-home-');
  const saved = process.env.AGENV_HOME;
  process.env.AGENV_HOME = home;
  t.after(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, 'AGENV_HOME');
    else process.env.AGENV_HOME = saved;
  });
  return home;
}

// runCommand

test('runCommand: resolves on exit code 0', async () => {
  await runCommand(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  });
});

test('runCommand: non-zero exit rejects with CliUserError', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.exit(3)'], {
      stdio: 'ignore',
    }),
    (err) => {
      assert.ok(
        err instanceof CliUserError,
        `expected CliUserError, got ${err?.constructor?.name}: ${err?.message}`,
      );
      assert.match(err.message, /exited with code 3/);
      return true;
    },
  );
});

test('runCommand: missing binary rejects with spawn error', async () => {
  await assert.rejects(
    runCommand('agenv-definitely-not-a-real-binary', [], { stdio: 'ignore' }),
    (err) => err.code === 'ENOENT',
  );
});

// findAgentBinary

test('findAgentBinary: resolves string bin field', async (t) => {
  const agentPath = await makeTempDir(t, 'agenv-bin-');
  const pkgDir = path.join(agentPath, 'node_modules', 'mytool');
  await fs.mkdir(path.join(pkgDir, 'bin'), { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    `${JSON.stringify({ name: 'mytool', bin: './bin/cli.js' })}\n`,
  );
  await fs.writeFile(path.join(pkgDir, 'bin', 'cli.js'), '');

  const found = await findAgentBinary(agentPath, 'mytool');
  assert.equal(found, path.join(pkgDir, 'bin', 'cli.js'));
});

test('findAgentBinary: resolves first entry of object bin field', async (t) => {
  const agentPath = await makeTempDir(t, 'agenv-bin-');
  const pkgDir = path.join(agentPath, 'node_modules', 'mytool');
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    `${JSON.stringify({ name: 'mytool', bin: { mytool: 'main.js', extra: 'extra.js' } })}\n`,
  );
  await fs.writeFile(path.join(pkgDir, 'main.js'), '');

  const found = await findAgentBinary(agentPath, 'mytool');
  assert.equal(found, path.join(pkgDir, 'main.js'));
});

test('findAgentBinary: falls back to node_modules/.bin for scoped packages', async (t) => {
  const agentPath = await makeTempDir(t, 'agenv-bin-');
  const binDir = path.join(agentPath, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, 'cli'), '');

  const found = await findAgentBinary(agentPath, '@scope/cli');
  assert.equal(found, path.join(binDir, 'cli'));
});

test('findAgentBinary: bin path missing on disk falls back to .bin', async (t) => {
  const agentPath = await makeTempDir(t, 'agenv-bin-');
  const pkgDir = path.join(agentPath, 'node_modules', 'mytool');
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    `${JSON.stringify({ name: 'mytool', bin: './missing.js' })}\n`,
  );
  const binDir = path.join(agentPath, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, 'mytool'), '');

  const found = await findAgentBinary(agentPath, 'mytool');
  assert.equal(found, path.join(binDir, 'mytool'));
});

test('findAgentBinary: returns null when nothing is found', async (t) => {
  const agentPath = await makeTempDir(t, 'agenv-bin-');
  assert.equal(await findAgentBinary(agentPath, 'mytool'), null);
});

test('findAgentBinary: malformed package.json does not throw', async (t) => {
  const agentPath = await makeTempDir(t, 'agenv-bin-');
  const pkgDir = path.join(agentPath, 'node_modules', 'mytool');
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(pkgDir, 'package.json'), '{not json');
  const binDir = path.join(agentPath, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, 'mytool'), '');

  const found = await findAgentBinary(agentPath, 'mytool');
  assert.equal(found, path.join(binDir, 'mytool'));
});

// ensureInstalled (hermetic via fake npm)

test('ensureInstalled: fresh install writes profile.json metadata', async (t) => {
  const home = await withTempAgenvHome(t);
  await withFakeNpm(t);

  const result = await ensureInstalled({
    profile: 'p1',
    name: 'codex',
    package: 'fake-agent',
    version: '1.0.0',
  });

  assert.equal(result.installed, true);
  assert.equal(result.meta.profile, 'p1');
  assert.equal(result.meta.agent, 'codex');
  assert.equal(result.meta.package, 'fake-agent');
  assert.equal(result.meta.version, '1.0.0');
  assert.equal(result.meta.pinned, false);

  const metaPath = path.join(home, 'agents', 'p1', 'profile.json');
  const raw = await fs.readFile(metaPath, 'utf8');
  assert.ok(raw.endsWith('\n'), 'profile.json must end with a newline');
  const meta = JSON.parse(raw);
  assert.equal(meta.version, '1.0.0');
  assert.ok(
    typeof meta.installedAt === 'string' && meta.installedAt.length > 0,
  );

  const configDir = path.join(home, 'agents', 'p1', 'config');
  await fs.access(configDir);
});

test('ensureInstalled: records the actually installed version', async (t) => {
  await withTempAgenvHome(t);
  await withFakeNpm(t, { FAKE_NPM_RESOLVED: '2.5.1' });

  const result = await ensureInstalled({
    profile: 'p1',
    name: 'codex',
    package: 'fake-agent',
    version: 'latest',
  });
  assert.equal(result.meta.version, '2.5.1');
});

test('ensureInstalled: same package and version skips reinstall and keeps installedAt', async (t) => {
  await withTempAgenvHome(t);
  await withFakeNpm(t);

  const target = {
    profile: 'p1',
    name: 'codex',
    package: 'fake-agent',
    version: '1.0.0',
  };
  const first = await ensureInstalled(target);
  const second = await ensureInstalled(target);

  assert.equal(second.installed, false);
  assert.equal(second.meta.installedAt, first.meta.installedAt);
});

test('ensureInstalled: legacy meta without channel field does not force reinstall', async (t) => {
  const home = await withTempAgenvHome(t);
  await withFakeNpm(t);

  const target = {
    profile: 'p1',
    name: 'codex',
    package: 'fake-agent',
    version: '1.0.0',
  };
  await ensureInstalled(target);

  // simulate a profile.json written by an older agenv (no channel field)
  const metaPath = path.join(home, 'agents', 'p1', 'profile.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  Reflect.deleteProperty(meta, 'channel');
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  const second = await ensureInstalled(target);
  assert.equal(second.installed, false);
});

test('ensureInstalled: version change triggers reinstall', async (t) => {
  await withTempAgenvHome(t);
  await withFakeNpm(t);

  const base = { profile: 'p1', name: 'codex', package: 'fake-agent' };
  await ensureInstalled({ ...base, version: '1.0.0' });
  const upgraded = await ensureInstalled({ ...base, version: '2.0.0' });

  assert.equal(upgraded.installed, true);
  assert.equal(upgraded.meta.version, '2.0.0');
});

test('ensureInstalled: force triggers reinstall', async (t) => {
  await withTempAgenvHome(t);
  await withFakeNpm(t);

  const target = {
    profile: 'p1',
    name: 'codex',
    package: 'fake-agent',
    version: '1.0.0',
  };
  await ensureInstalled(target);
  const forced = await ensureInstalled(target, { force: true });
  assert.equal(forced.installed, true);
});

// agenv install (CLI) — agent default env injection

async function runCliInstall(t, args, extraEnv = {}) {
  // fake npm is already first on PATH via withFakeNpm (process.env mutation),
  // and the spawned CLI inherits it through env below
  return execFileAsync('node', [cliPath, ...args], {
    env: {
      ...process.env,
      AGENV_NO_UPDATE_CHECK: '1',
      ...extraEnv,
    },
    maxBuffer: 1024 * 1024,
  });
}

test('install claude: saves DISABLE_AUTOUPDATER=1 as profile env default', async (t) => {
  const home = await withTempAgenvHome(t);
  await withFakeNpm(t);

  await runCliInstall(t, ['install', 'claude']);

  const cfg = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(cfg.profiles.claude.env.DISABLE_AUTOUPDATER, '1');
});

test('install gemini: saves GEMINI_FORCE_FILE_STORAGE=true as profile env default', async (t) => {
  const home = await withTempAgenvHome(t);
  await withFakeNpm(t);

  await runCliInstall(t, ['install', 'gemini']);

  const cfg = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(cfg.profiles.gemini.env.GEMINI_FORCE_FILE_STORAGE, 'true');
});

test('install: user-provided --env overrides the agent default env', async (t) => {
  const home = await withTempAgenvHome(t);
  await withFakeNpm(t);

  await runCliInstall(t, [
    'install',
    'gemini',
    '--env',
    'GEMINI_FORCE_FILE_STORAGE=false',
  ]);

  const cfg = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(cfg.profiles.gemini.env.GEMINI_FORCE_FILE_STORAGE, 'false');
});

test('install codex: no default env is injected', async (t) => {
  const home = await withTempAgenvHome(t);
  await withFakeNpm(t);

  await runCliInstall(t, ['install', 'codex']);

  const cfg = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(cfg.profiles?.codex?.env, undefined);
});

test('ensureInstalled: npm failure rejects with CliUserError', async (t) => {
  await withTempAgenvHome(t);
  await withFakeNpm(t, { FAKE_NPM_MODE: 'fail' });

  await assert.rejects(
    ensureInstalled({
      profile: 'p1',
      name: 'codex',
      package: 'fake-agent',
      version: '1.0.0',
    }),
    (err) => {
      assert.ok(
        err instanceof CliUserError,
        `expected CliUserError, got ${err?.constructor?.name}: ${err?.message}`,
      );
      return true;
    },
  );
});
