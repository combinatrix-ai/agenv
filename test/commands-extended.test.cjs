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
    pinned: false,
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
    `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst out=process.env.TEST_OUTPUT;\nif(!out) process.exit(2);\nfs.writeFileSync(out, JSON.stringify({argv:process.argv.slice(2), env:{A:process.env.A,B:process.env.B,C:process.env.C,X:process.env.X,CODEX_HOME:process.env.CODEX_HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,GEMINI_CLI_HOME:process.env.GEMINI_CLI_HOME,AGENV_PROFILE:process.env.AGENV_PROFILE}}));\n`,
  );
  await fs.chmod(binPath, 0o755);
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

test('show displays profile details in plain text', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'work');

  const result = await runCli(['show', 'work'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  assert.match(result.stdout, /Profile:\s*work/);
  assert.match(result.stdout, /Agent:\s*codex@1\.0\.0/);
  assert.match(result.stdout, /Package:\s*fake-agent/);
});

test('show --json returns valid JSON with expected fields', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'work');

  const result = await runCli(['show', 'work', '--json'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.profile, 'work');
  assert.equal(parsed.agent, 'codex');
  assert.equal(parsed.version, '1.0.0');
  assert.equal(parsed.package, 'fake-agent');
  assert.ok(parsed.binPath?.includes('agent.js'));
  await assert.doesNotReject(fs.access(parsed.binPath));
});

test('show redacts long secret values to prefix***suffix', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'work');
  await writeJson(path.join(home, '.agenv.json'), {
    profiles: {
      work: {
        env: {
          OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
          SHORT_TOKEN: 'tinyval',
          PUBLIC_VAR: 'plain-value-shown-as-is',
        },
      },
    },
  });

  const result = await runCli(['show', 'work', '--json'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const parsed = JSON.parse(result.stdout);
  const env = parsed.scopes.global.env;
  assert.equal(env.OPENAI_API_KEY, 'sk-***xyz');
  assert.equal(env.SHORT_TOKEN, '***');
  assert.equal(env.PUBLIC_VAR, 'plain-value-shown-as-is');
});

test('show --reveal exposes raw secret values', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'work');
  await writeJson(path.join(home, '.agenv.json'), {
    profiles: {
      work: {
        env: {
          OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
        },
      },
    },
  });

  const result = await runCli(['show', 'work', '--json', '--reveal'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const parsed = JSON.parse(result.stdout);
  assert.equal(
    parsed.scopes.global.env.OPENAI_API_KEY,
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
  );
});

// ---------------------------------------------------------------------------
// clone
// ---------------------------------------------------------------------------

test('clone copies a profile and its settings', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'src');
  await writeJson(path.join(home, '.agenv.json'), {
    profiles: {
      src: {
        args: '--model gpt-5',
        env: { FOO: 'bar' },
      },
    },
  });

  const result = await runCli(['clone', 'src', 'dst'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  assert.match(result.stdout, /Cloned "src" -> "dst"/);

  // Verify target profile directory exists
  const dstMeta = JSON.parse(
    await fs.readFile(path.join(home, 'agents', 'dst', 'profile.json'), 'utf8'),
  );
  assert.equal(dstMeta.profile, 'dst');
  assert.equal(dstMeta.agent, 'codex');

  // Verify settings were copied in global config
  const globalConfig = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );
  assert.equal(globalConfig.profiles.dst.args, '--model gpt-5');
  assert.deepEqual(globalConfig.profiles.dst.env, { FOO: 'bar' });
});

test('clone errors when target already exists', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'src');
  await createFakeProfile(home, 'dst');

  await assert.rejects(
    runCli(['clone', 'src', 'dst'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    (err) => {
      assert.match(err.stderr, /already exists/);
      return true;
    },
  );
});

test('package and registry options are invalid', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });
  await createFakeProfile(home, 'src');

  for (const args of [
    ['install', 'codex', '--package', 'fake-agent'],
    ['install', 'codex', '--registry', 'https://registry.example.invalid'],
    ['update', 'src', '--registry', 'https://registry.example.invalid'],
    ['clone', 'src', 'dst', '--registry', 'https://registry.example.invalid'],
  ]) {
    await assert.rejects(
      runCli(args, {
        cwd,
        env: { AGENV_HOME: home },
      }),
      (err) => {
        assert.match(err.stderr, /unknown option/);
        return true;
      },
    );
  }
});

test('update requires concrete pin versions', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });
  await createFakeProfile(home, 'work');

  await assert.rejects(
    runCli(['update', 'work', '--pin', 'latest'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    (err) => {
      assert.match(err.stderr, /Pin version must be a concrete version/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// run --dry-run
// ---------------------------------------------------------------------------

test('run --dry-run shows preview without executing', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  const outputFile = path.join(tmp, 'output.json');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'work');
  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'work',
  });

  const result = await runCli(['run', 'work', '--dry-run'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputFile },
  });

  assert.match(result.stdout, /Profile:\s+work/);
  assert.match(result.stdout, /Agent:\s+codex@1\.0\.0/);
  assert.match(result.stdout, /Binary:/);

  // Agent binary should NOT have been executed
  await assert.rejects(fs.access(outputFile));
});

// ---------------------------------------------------------------------------
// run --yolo
// ---------------------------------------------------------------------------

test('run --yolo injects agent-specific auto-approve args', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  const outputFile = path.join(tmp, 'output.json');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'work', { agent: 'codex' });
  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'work',
  });

  await runCli(['run', 'work', '--yolo'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputFile },
  });

  const output = JSON.parse(await fs.readFile(outputFile, 'utf8'));
  assert.ok(
    output.argv.includes('--yolo'),
    `Expected --yolo in argv: ${JSON.stringify(output.argv)}`,
  );
});

// ---------------------------------------------------------------------------
// run --debug
// ---------------------------------------------------------------------------

test('run --debug prints debug lines', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  const outputFile = path.join(tmp, 'output.json');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'work');
  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'work',
  });

  const result = await runCli(['run', 'work', '--debug'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputFile },
  });

  assert.match(result.stdout, /debug: selector/);
  assert.match(result.stdout, /debug: config/);
  assert.match(result.stdout, /debug: effective/);
  assert.match(result.stdout, /debug: runtime/);
  assert.match(result.stdout, /debug: argv/);
});

// ---------------------------------------------------------------------------
// --env-file
// ---------------------------------------------------------------------------

test('edit --env-file loads env from dotenv file', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'work');

  const envFile = path.join(tmp, '.env');
  await fs.writeFile(
    envFile,
    '# comment\nAPI_KEY=secret123\nDB_HOST="localhost"\nEMPTY=\n',
  );

  await runCli(['edit', 'global', 'work', '--env-file', envFile], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const globalConfig = JSON.parse(
    await fs.readFile(path.join(home, '.agenv.json'), 'utf8'),
  );

  assert.equal(globalConfig.profiles.work.env.API_KEY, 'secret123');
  assert.equal(globalConfig.profiles.work.env.DB_HOST, 'localhost');
});

// ---------------------------------------------------------------------------
// AGENV_PROFILE env var
// ---------------------------------------------------------------------------

test('run sets AGENV_PROFILE in the agent environment', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  const outputFile = path.join(tmp, 'output.json');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'myprofile');
  await writeJson(path.join(home, '.agenv.json'), {
    defaultProfile: 'myprofile',
  });

  await runCli(['run', 'myprofile'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputFile },
  });

  const output = JSON.parse(await fs.readFile(outputFile, 'utf8'));
  assert.equal(output.env.AGENV_PROFILE, 'myprofile');
});

// ---------------------------------------------------------------------------
// pinned profiles
// ---------------------------------------------------------------------------

async function createPinnedProfile(
  home,
  profile,
  { agent = 'codex', version = '1.0.0' } = {},
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
    version,
    pinned: true,
    installedAt: '2026-01-01T00:00:00.000Z',
  });

  await writeJson(
    path.join(agentPath, 'node_modules', packageName, 'package.json'),
    { name: packageName, version, bin: 'bin/agent.js' },
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
    `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst out=process.env.TEST_OUTPUT;\nif(!out) process.exit(2);\nfs.writeFileSync(out, JSON.stringify({argv:process.argv.slice(2), env:{}}));\n`,
  );
  await fs.chmod(binPath, 0o755);
}

test('show displays pinned indicator for pinned profiles', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createPinnedProfile(home, 'pinned-work');

  const result = await runCli(['show', 'pinned-work'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  assert.match(result.stdout, /Agent:\s*codex@1\.0\.0 \(pinned\)/);
});

test('show --json includes pinned field', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createPinnedProfile(home, 'pinned-work');

  const result = await runCli(['show', 'pinned-work', '--json'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.pinned, true);
  assert.equal(parsed.version, '1.0.0');
});

test('show --json returns pinned=false for unpinned profiles', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createFakeProfile(home, 'work');

  const result = await runCli(['show', 'work', '--json'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.pinned, false);
});

test('list shows pinned indicator in version column', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createPinnedProfile(home, 'pinned-work');
  await createFakeProfile(home, 'normal');

  const result = await runCli(['ls'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  assert.match(result.stdout, /v1\.0\.0 \(pinned\)/);
  // unpinned profile should not have (pinned)
  const lines = result.stdout.split('\n');
  const normalLine = lines.find((l) => l.includes('normal'));
  assert.ok(normalLine);
  assert.ok(!normalLine.includes('(pinned)'));
});

test('list --json includes pinned field in profiles', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  await fs.mkdir(cwd, { recursive: true });

  await createPinnedProfile(home, 'pinned-work');

  const result = await runCli(['ls', '--json'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const parsed = JSON.parse(result.stdout);
  const profile = parsed.profiles.find((p) => p.profile === 'pinned-work');
  assert.ok(profile);
  assert.equal(profile.pinned, true);
});
