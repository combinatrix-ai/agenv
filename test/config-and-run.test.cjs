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
  await fs.writeFile(
    binPath,
    `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst out=process.env.TEST_OUTPUT;\nif(!out) process.exit(2);\nfs.writeFileSync(out, JSON.stringify({argv:process.argv.slice(2), env:{A:process.env.A,B:process.env.B,C:process.env.C,X:process.env.X,CODEX_HOME:process.env.CODEX_HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,GEMINI_CLI_HOME:process.env.GEMINI_CLI_HOME}}));\n`,
  );
  await fs.chmod(binPath, 0o755);
}

test('run resolves config with nearest project config only (ignores parent configs)', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  const cwd = path.join(project, 'apps', 'web');
  const outputFile = path.join(tmp, 'run-output.json');

  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1');
  await createFakeProfile(home, 'p2');

  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'p2',
    profiles: {
      p1: {
        env: {
          A: 'global',
        },
      },
    },
  });

  await writeJson(path.join(project, '.agenv.json'), {
    defaultProfile: 'p2',
    profiles: {
      p1: {
        env: {
          C: 'parent-only',
        },
      },
    },
  });

  await writeJson(path.join(project, 'apps', '.agenv.json'), {
    defaultProfile: 'p1',
    profiles: {
      p1: {
        args: '--from-nearest yes',
        env: {
          A: 'nearest',
          B: 'nearest',
        },
      },
    },
  });

  const current = await runCli(['list'], {
    cwd,
    env: { AGENV_HOME: home },
  });
  assert.match(current.stdout, /^p1\s+\S+\s+\S+\s+\S+\s+\S+\s+.*default/m);

  await runCli(['run', 'p1', '--', '--cli', 'flag'], {
    cwd,
    env: {
      AGENV_HOME: home,
      TEST_OUTPUT: outputFile,
    },
  });

  const raw = await fs.readFile(outputFile, 'utf8');
  const result = JSON.parse(raw);

  assert.deepEqual(result.argv, ['--from-nearest', 'yes', '--cli', 'flag']);
  assert.equal(result.env.A, 'nearest');
  assert.equal(result.env.B, 'nearest');
  assert.equal(result.env.C, undefined);
  assert.equal(
    result.env.CODEX_HOME,
    path.join(home, 'agents', 'p1', 'config'),
  );
});

test('default and edit local commands write default/agent/args/env settings', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1');

  await runCli(['default', 'local', 'p1'], {
    cwd,
    env: { AGENV_HOME: home },
  });
  await runCli(['default', 'local', 'p1', '--for', 'codex'], {
    cwd,
    env: { AGENV_HOME: home },
  });
  await runCli(
    [
      'edit',
      'local',
      'p1',
      '--env',
      'FOO=1',
      '--env',
      'BAR=2',
      '--',
      '--foo',
      'bar',
    ],
    {
      cwd,
      env: { AGENV_HOME: home },
    },
  );

  const configPath = path.join(cwd, '.agenv.json');
  const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));

  assert.equal(parsed.defaultProfile, 'p1');
  assert.equal(parsed.agentDefaults.codex, 'p1');
  assert.equal(parsed.profiles.p1.args, '--foo bar');
  assert.deepEqual(parsed.profiles.p1.env, { FOO: '1', BAR: '2' });
});

test('default global writes AGENV_HOME/.agenv.json', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1');

  await runCli(['default', 'global', 'p1'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const globalConfig = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(globalConfig.defaultProfile, 'p1');
});

test('default --for writes agentDefaults', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1', { agent: 'codex' });

  await runCli(['default', 'global', 'p1', '--for', 'codex'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const globalConfig = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(globalConfig.agentDefaults.codex, 'p1');
  assert.equal(globalConfig.defaultProfile ?? null, null);
});

test('default --for rejects when profile agent does not match', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1', { agent: 'codex' });

  await assert.rejects(
    runCli(['default', 'global', 'p1', '--for', 'claude'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    /installed for agent "codex", not "claude"/,
  );
});

test('edit local always edits cwd .agenv.json, not parent config', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  const cwd = path.join(project, 'apps', 'web');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1');
  await writeJson(path.join(project, '.agenv.json'), {
    defaultProfile: 'p1',
    profiles: { p1: { env: { PARENT: '1' } } },
  });

  await runCli(['edit', 'local', 'p1', '--env', 'CHILD=1'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const projectConfig = JSON.parse(
    await fs.readFile(path.join(project, '.agenv.json'), 'utf8'),
  );
  assert.equal(projectConfig.profiles.p1.env.CHILD, undefined);

  const cwdConfig = JSON.parse(
    await fs.readFile(path.join(cwd, '.agenv.json'), 'utf8'),
  );
  assert.equal(cwdConfig.defaultProfile, undefined);
  assert.deepEqual(cwdConfig.profiles.p1.env, { CHILD: '1' });
});

test('edit local rejects profiles that are not installed', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await assert.rejects(
    runCli(['edit', 'local', 'missing', '--env', 'CHILD=1'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    (err) => {
      assert.match(err.stderr, /Profile "missing" is not installed/);
      return true;
    },
  );

  await assert.rejects(fs.access(path.join(cwd, '.agenv.json')), /ENOENT/);
});

test('schema validation rejects unknown config properties', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1');
  await writeJson(path.join(cwd, '.agenv.json'), {
    defaultProfile: 'p1',
    profiles: {
      p1: {
        env: { OK: '1' },
        extra: true,
      },
    },
  });

  await assert.rejects(
    runCli(['list'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    /unknown property "extra"/,
  );
});

test('schema validation rejects non-normalized profile selectors', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1');
  await writeJson(path.join(cwd, '.agenv.json'), {
    defaultProfile: 'P1',
  });

  await assert.rejects(
    runCli(['list'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    /defaultProfile: must match pattern/,
  );
});

test('run supports explicit --profile/--agent and rejects selector conflicts', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  const outputBySelector = path.join(tmp, 'run-selector.json');
  const outputByProfile = path.join(tmp, 'run-profile.json');
  const outputByAgent = path.join(tmp, 'run-agent.json');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'codex', { agent: 'claude' });
  await createFakeProfile(home, 'work', { agent: 'codex' });

  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'work',
  });

  await runCli(['run', 'codex', '--', '--selector'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputBySelector },
  });
  const selectorResult = JSON.parse(
    await fs.readFile(outputBySelector, 'utf8'),
  );
  assert.equal(
    selectorResult.env.CODEX_HOME,
    path.join(home, 'agents', 'work', 'config'),
  );
  assert.equal(selectorResult.env.CLAUDE_CONFIG_DIR, undefined);
  assert.deepEqual(selectorResult.argv, ['--selector']);

  await runCli(['run', '--profile', 'codex', '--', '--profile-flag'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputByProfile },
  });
  const profileResult = JSON.parse(await fs.readFile(outputByProfile, 'utf8'));
  assert.equal(
    profileResult.env.CLAUDE_CONFIG_DIR,
    path.join(home, 'agents', 'codex', 'config'),
  );
  assert.equal(profileResult.env.CODEX_HOME, undefined);
  assert.deepEqual(profileResult.argv, ['--profile-flag']);

  await runCli(['run', '--agent', 'codex', '--', '--agent-flag'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputByAgent },
  });
  const agentResult = JSON.parse(await fs.readFile(outputByAgent, 'utf8'));
  assert.equal(
    agentResult.env.CODEX_HOME,
    path.join(home, 'agents', 'work', 'config'),
  );
  assert.deepEqual(agentResult.argv, ['--agent-flag']);

  await assert.rejects(
    runCli(['run', 'work', '--agent', 'codex'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    /Cannot combine positional selector with --profile\/--agent/,
  );

  await assert.rejects(
    runCli(['run', '--profile', 'work', '--agent', 'codex'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    /Cannot use --profile and --agent together/,
  );
});

test('parse errors show normalized help hints', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await assert.rejects(
    runCli(['run', '--agent'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    /Missing value for --agent\. Use one of: codex, claude, gemini\.\nSee: agenv run --help/,
  );

  await assert.rejects(
    runCli(['unknowncmd'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    /unknown command 'unknowncmd'\nSee: agenv --help/,
  );
});

test('run errors when local defaultProfile points to a missing profile', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'codex', { agent: 'codex' });

  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'codex',
  });

  const projectConfigPath = path.join(cwd, '.agenv.json');
  await writeJson(projectConfigPath, {
    defaultProfile: 'missing',
  });

  await assert.rejects(
    runCli(['run'], { cwd, env: { AGENV_HOME: home } }),
    (err) => {
      assert.match(
        err.stderr,
        /Project config .*\.agenv\.json sets defaultProfile to "missing", but that profile is not installed\./,
      );
      assert.match(err.stderr, /agenv default local <other>/);
      return true;
    },
  );
});

test('run errors when local agentDefaults points to a missing profile (only when that selector is used)', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  const outputFile = path.join(tmp, 'run-output.json');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'codex', { agent: 'codex' });
  await createFakeProfile(home, 'gemini', { agent: 'gemini' });

  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'codex',
  });

  await writeJson(path.join(cwd, '.agenv.json'), {
    agentDefaults: { codex: 'missing' },
  });

  // selector targets codex → error
  await assert.rejects(
    runCli(['run', 'codex'], { cwd, env: { AGENV_HOME: home } }),
    (err) => {
      assert.match(
        err.stderr,
        /Project config .*\.agenv\.json sets agentDefaults\.codex to "missing", but that profile is not installed\./,
      );
      return true;
    },
  );

  // selector targets gemini (unrelated) → still works
  const result = await runCli(['run', 'gemini'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputFile },
  });
  const runData = JSON.parse(await fs.readFile(outputFile, 'utf8'));
  assert.equal(
    runData.env.GEMINI_CLI_HOME,
    path.join(home, 'agents', 'gemini', 'config'),
  );
  assert.match(result.stdout, /Using/);
});

test('run errors when local agentDefaults points to a profile of a different agent', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'codex', { agent: 'codex' });
  await createFakeProfile(home, 'claude-pro', { agent: 'claude' });

  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'codex',
  });

  await writeJson(path.join(cwd, '.agenv.json'), {
    agentDefaults: { codex: 'claude-pro' },
  });

  await assert.rejects(
    runCli(['run', 'codex'], { cwd, env: { AGENV_HOME: home } }),
    (err) => {
      assert.match(
        err.stderr,
        /agentDefaults\.codex to "claude-pro", but that profile is installed for agent "claude", not "codex"\./,
      );
      return true;
    },
  );
});

test('run --tui requires an interactive TTY', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1');

  await assert.rejects(
    runCli(['run', '--tui'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    /TUI requires an interactive terminal/,
  );
});

test('edit supports editing args/env in global config', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1');

  await runCli(['default', 'global', 'p1'], {
    cwd,
    env: { AGENV_HOME: home },
  });
  await runCli(['edit', 'global', 'p1', '--env', 'FOO=1', '--', '--version'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const globalConfig = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(globalConfig.defaultProfile, 'p1');
  assert.equal(globalConfig.profiles.p1.args, '--version');
  assert.deepEqual(globalConfig.profiles.p1.env, { FOO: '1' });

  await runCli(['default', 'local', 'p1'], {
    cwd,
    env: { AGENV_HOME: home },
  });
  await runCli(['default', 'local', 'p1', '--for', 'codex'], {
    cwd,
    env: { AGENV_HOME: home },
  });
  await runCli(['edit', 'local', 'p1', '--', '--model', 'gpt-5'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const localConfig = JSON.parse(
    await fs.readFile(path.join(cwd, '.agenv.json'), 'utf8'),
  );
  assert.equal(localConfig.defaultProfile, 'p1');
  assert.equal(localConfig.agentDefaults.codex, 'p1');
  assert.equal(localConfig.profiles.p1.args, '--model gpt-5');
});

test('list auto-heals global defaults by oldest installedAt', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'newer-codex', {
    agent: 'codex',
    installedAt: '2026-01-02T00:00:00.000Z',
  });
  await createFakeProfile(home, 'first-codex', {
    agent: 'codex',
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  await createFakeProfile(home, 'only-claude', {
    agent: 'claude',
    installedAt: '2026-01-03T00:00:00.000Z',
  });

  await runCli(['list'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const globalConfig = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(globalConfig.defaultProfile, 'first-codex');
  assert.equal(globalConfig.agentDefaults.codex, 'first-codex');
  assert.equal(globalConfig.agentDefaults.claude, 'only-claude');
  assert.equal(globalConfig.agentDefaults.gemini, undefined);
});

test('remove auto-heals global defaults when selected profile is deleted', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'a-old', {
    agent: 'claude',
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  await createFakeProfile(home, 'b-new', {
    agent: 'claude',
    installedAt: '2026-01-02T00:00:00.000Z',
  });

  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'a-old',
    agentDefaults: {
      claude: 'a-old',
    },
  });

  await runCli(['remove', 'a-old'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const globalConfig = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(globalConfig.defaultProfile, 'b-new');
  assert.equal(globalConfig.agentDefaults.claude, 'b-new');
});

test('list --json includes resolves tags for default and agent selectors', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'p1', { agent: 'codex' });

  const plain = await runCli(['list', '--json'], {
    cwd,
    env: { AGENV_HOME: home },
  });
  const plainParsed = JSON.parse(plain.stdout);
  assert.ok(Array.isArray(plainParsed.profiles));
  assert.equal(plainParsed.profiles.length, 1);
  // single installed profile resolves both `agenv run` and `agenv run codex`
  assert.deepEqual(plainParsed.profiles[0].resolves.sort(), [
    'codex',
    'default',
  ]);
});

test('list --json returns empty profiles array when no profiles installed', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  const plain = await runCli(['list', '--json'], {
    cwd,
    env: { AGENV_HOME: home },
  });
  const plainParsed = JSON.parse(plain.stdout);
  assert.deepEqual(plainParsed, { profiles: [] });
});

test('install alias accepts saved args after delimiter', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await assert.rejects(
    runCli(['i', 'gpt', '--', '--foo'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    (err) => {
      assert.match(err.stderr, /Unsupported agent "gpt"/);
      assert.doesNotMatch(err.stderr, /Saved args must be passed after "--"/);
      return true;
    },
  );
});

test('agenv update notice uses stderr instead of stdout', async (t) => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const originalNoUpdateCheck = process.env.AGENV_NO_UPDATE_CHECK;
  const stdout = [];
  const stderr = [];

  t.after(() => {
    global.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    if (originalNoUpdateCheck === undefined) {
      Reflect.deleteProperty(process.env, 'AGENV_NO_UPDATE_CHECK');
    } else {
      process.env.AGENV_NO_UPDATE_CHECK = originalNoUpdateCheck;
    }
  });

  Reflect.deleteProperty(process.env, 'AGENV_NO_UPDATE_CHECK');
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ version: '9.9.9' }),
  });
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));

  const { maybeNotifySelfUpdate } = require('../dist/selfUpdate');
  await maybeNotifySelfUpdate();

  assert.deepEqual(stdout, []);
  assert.match(stderr.join('\n'), /A new version of agenv is available/);
});
