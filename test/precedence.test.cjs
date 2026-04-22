const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

async function runCli(args, { cwd, env }) {
  return execFileAsync('node', [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      AGENV_NO_UPDATE_CHECK: '1',
      ...env,
    },
    maxBuffer: 1024 * 1024,
  });
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

const STUB_AGENT_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const out = process.env.TEST_OUTPUT;
if (!out) process.exit(2);
const keys = (process.env.TEST_DUMP_KEYS || '').split(',').filter(Boolean);
const env = {};
for (const k of keys) env[k] = process.env[k];
fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), env }));
`;

async function createFakeProfile(
  home,
  profile,
  { agent = 'codex', installedAt = '2026-01-01T00:00:00.000Z' } = {},
) {
  const profilePath = path.join(home, 'agents', profile);
  const agentPath = path.join(profilePath, 'agent');
  const configPath = path.join(profilePath, 'config');
  const packageName = 'fake-agent';

  await fs.mkdir(path.join(agentPath, 'node_modules', packageName, 'bin'), {
    recursive: true,
  });
  await fs.mkdir(configPath, { recursive: true });

  await writeJson(path.join(profilePath, 'profile.json'), {
    profile,
    agent,
    package: packageName,
    version: '1.0.0',
    installedAt,
  });

  await writeJson(
    path.join(agentPath, 'node_modules', packageName, 'package.json'),
    {
      name: packageName,
      version: '1.0.0',
      bin: 'bin/agent.js',
    },
  );

  const binPath = path.join(
    agentPath,
    'node_modules',
    packageName,
    'bin',
    'agent.js',
  );
  await fs.writeFile(binPath, STUB_AGENT_SOURCE);
  await fs.chmod(binPath, 0o755);

  return { profilePath, agentPath, configPath };
}

async function setup(t, profileEnv = {}, projectEnv = null) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-prec-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  const cwd = project;
  const outputFile = path.join(tmp, 'run-output.json');
  await fs.mkdir(project, { recursive: true });

  const { configPath } = await createFakeProfile(home, 'p1');

  const globalConfig = { defaultProfile: 'p1', profiles: { p1: profileEnv } };
  await writeJson(path.join(home, '.agenv.json'), globalConfig);

  if (projectEnv) {
    await writeJson(path.join(project, '.agenv.json'), {
      profiles: { p1: projectEnv },
    });
  }

  return { tmp, home, project, cwd, outputFile, configPath };
}

async function readResult(outputFile) {
  const raw = await fs.readFile(outputFile, 'utf8');
  return JSON.parse(raw);
}

// =============================================================================
// A. Args composition
// =============================================================================

test('A1: saved args and runtime args are concatenated in order', async (t) => {
  const { home, cwd, outputFile } = await setup(t, {
    args: '--saved yes',
  });

  await runCli(['run', 'p1', '--', '--cli', 'flag'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputFile },
  });

  const result = await readResult(outputFile);
  assert.deepEqual(result.argv, ['--saved', 'yes', '--cli', 'flag']);
});

test('A2: --yolo args insert between saved and runtime args', async (t) => {
  const { home, cwd, outputFile } = await setup(t, { args: '--saved' });

  await runCli(['run', 'p1', '--yolo', '--', '--cli'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputFile },
  });

  const result = await readResult(outputFile);
  // codex yolo args = ['--full-auto']
  assert.deepEqual(result.argv, ['--saved', '--full-auto', '--cli']);
});

test('A3: project args replace global args entirely', async (t) => {
  const { home, cwd, outputFile } = await setup(
    t,
    { args: '--global only' },
    { args: '--project only' },
  );

  await runCli(['run'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputFile },
  });

  const result = await readResult(outputFile);
  assert.deepEqual(result.argv, ['--project', 'only']);
});

// =============================================================================
// B. Env precedence
// =============================================================================

test('B1: profile env passes through when shell has nothing', async (t) => {
  const { home, cwd, outputFile } = await setup(t, {
    env: { FOO: 'profile' },
  });

  await runCli(['run'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
      TEST_DUMP_KEYS: 'FOO',
    },
  });

  const result = await readResult(outputFile);
  assert.equal(result.env.FOO, 'profile');
});

test('B2: profile env wins over shell env', async (t) => {
  const { home, cwd, outputFile } = await setup(t, {
    env: { FOO: 'profile' },
  });

  await runCli(['run'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
      TEST_DUMP_KEYS: 'FOO',
      FOO: 'shell',
    },
  });

  const result = await readResult(outputFile);
  assert.equal(result.env.FOO, 'profile');
});

test('B2b: --env wins over both profile env and shell env', async (t) => {
  const { home, cwd, outputFile } = await setup(t, {
    env: { FOO: 'profile' },
  });

  await runCli(['run', '--env', 'FOO=runtime'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
      TEST_DUMP_KEYS: 'FOO',
      FOO: 'shell',
    },
  });

  const result = await readResult(outputFile);
  assert.equal(result.env.FOO, 'runtime');
});

test('B3: shell env passes through when profile has nothing', async (t) => {
  const { home, cwd, outputFile } = await setup(t, {});

  await runCli(['run'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
      TEST_DUMP_KEYS: 'FOO',
      FOO: 'shell',
    },
  });

  const result = await readResult(outputFile);
  assert.equal(result.env.FOO, 'shell');
});

test('B4: mandatory injection (CODEX_HOME, AGENV_PROFILE) wins over shell', async (t) => {
  const { home, cwd, outputFile, configPath } = await setup(t, {});

  await runCli(['run'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
      TEST_DUMP_KEYS: 'CODEX_HOME,AGENV_PROFILE',
      CODEX_HOME: '/tmp/hijack',
      AGENV_PROFILE: 'hijack',
    },
  });

  const result = await readResult(outputFile);
  assert.equal(result.env.CODEX_HOME, configPath);
  assert.equal(result.env.AGENV_PROFILE, 'p1');
});

// =============================================================================
// C. Project / global env merge
// =============================================================================

test('C1: project env merges with global env per-key', async (t) => {
  const { home, cwd, outputFile } = await setup(
    t,
    { env: { A: 'global', B: 'global' } },
    { env: { B: 'project', C: 'project' } },
  );

  await runCli(['run'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
      TEST_DUMP_KEYS: 'A,B,C',
    },
  });

  const result = await readResult(outputFile);
  assert.equal(result.env.A, 'global');
  assert.equal(result.env.B, 'project');
  assert.equal(result.env.C, 'project');
});

test('C2: merged profile env wins over shell env', async (t) => {
  const { home, cwd, outputFile } = await setup(
    t,
    { env: { A: 'global', B: 'global' } },
    { env: { B: 'project' } },
  );

  await runCli(['run'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
      TEST_DUMP_KEYS: 'A,B',
      A: 'shell',
    },
  });

  const result = await readResult(outputFile);
  assert.equal(result.env.A, 'global'); // profile global wins over shell
  assert.equal(result.env.B, 'project');
});

// =============================================================================
// D. Integration
// =============================================================================

test('D1: full precedence — global, project, shell, runtime args together', async (t) => {
  const { home, cwd, outputFile } = await setup(
    t,
    {
      args: '--from-global',
      env: { FOO: 'global', BAR: 'global' },
    },
    {
      args: '--from-project',
      env: { BAR: 'project', BAZ: 'project' },
    },
  );

  await runCli(['run', 'p1', '--', '--from-cli'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
      TEST_DUMP_KEYS: 'FOO,BAR,BAZ,QUX,AGENV_PROFILE',
      FOO: 'shell',
      QUX: 'shell',
    },
  });

  const result = await readResult(outputFile);

  // Args: project replaces global, then runtime appends
  assert.deepEqual(result.argv, ['--from-project', '--from-cli']);

  // Env precedence: shell is the base; profile (project-over-global)
  // overrides per-key; mandatory wins. --env (none here) would top profile.
  assert.equal(result.env.FOO, 'global'); // global profile beats shell
  assert.equal(result.env.BAR, 'project'); // project beats global, no shell
  assert.equal(result.env.BAZ, 'project'); // project only, no shell
  assert.equal(result.env.QUX, 'shell'); // shell only, profile blank
  assert.equal(result.env.AGENV_PROFILE, 'p1'); // mandatory injection
});

test('D2: --yolo composes with project args, profile env still wins over shell', async (t) => {
  const { home, cwd, outputFile } = await setup(
    t,
    { env: { FOO: 'profile' } },
    { args: '--from-project' },
  );

  await runCli(['run', 'p1', '--yolo', '--', '--from-cli'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
      TEST_DUMP_KEYS: 'FOO',
      FOO: 'shell',
    },
  });

  const result = await readResult(outputFile);
  // saved (--from-project) + yolo (--full-auto) + runtime (--from-cli)
  assert.deepEqual(result.argv, [
    '--from-project',
    '--full-auto',
    '--from-cli',
  ]);
  assert.equal(result.env.FOO, 'profile');
});
