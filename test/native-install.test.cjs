const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

async function makeTempDir(t, prefix) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

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

function claudePlatform() {
  const osName = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${osName}-${arch}`;
}

// A fake "claude binary" the download server serves. It must run standalone
// (no node_modules) and dump argv/env so run-path tests can assert on it.
const FAKE_CLAUDE_BIN = `#!/usr/bin/env node
const fs = require('node:fs');
const out = process.env.TEST_OUTPUT;
if (!out) process.exit(2);
fs.writeFileSync(
  out,
  JSON.stringify({
    argv: process.argv.slice(2),
    env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
  }),
);
`;

// Local stand-in for downloads.claude.ai/claude-code-releases.
async function startClaudeServer(
  t,
  {
    latestVersion = '3.2.1',
    versions = null,
    binaryContent = FAKE_CLAUDE_BIN,
    badChecksum = false,
  } = {},
) {
  const platform = claudePlatform();
  const served = versions || [latestVersion];
  const checksum = badChecksum
    ? 'a'.repeat(64)
    : crypto.createHash('sha256').update(binaryContent).digest('hex');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/latest') {
      res.end(latestVersion);
      return;
    }
    for (const version of served) {
      if (req.url === `/${version}/manifest.json`) {
        res.end(JSON.stringify({ platforms: { [platform]: { checksum } } }));
        return;
      }
      if (req.url === `/${version}/${platform}/claude`) {
        res.end(binaryContent);
        return;
      }
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
  };
}

// Fake codex standalone installer (stands in for chatgpt.com/codex/install.sh).
const FAKE_CODEX_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$CODEX_INSTALL_DIR"
cat > "$CODEX_INSTALL_DIR/codex" <<'BIN'
#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli 9.9.9"
  exit 0
fi
if [ -n "$TEST_OUTPUT" ]; then
  printf '{"argv":"%s","CODEX_HOME":"%s"}' "$*" "$CODEX_HOME" > "$TEST_OUTPUT"
fi
BIN
chmod +x "$CODEX_INSTALL_DIR/codex"
{
  echo "ARGS=$*"
  echo "CODEX_HOME=$CODEX_HOME"
  echo "CODEX_INSTALL_DIR=$CODEX_INSTALL_DIR"
  echo "CODEX_NON_INTERACTIVE=$CODEX_NON_INTERACTIVE"
} > "$AGENV_TEST_INSTALLER_TRACE"
`;

async function writeFakeCodexInstaller(t) {
  const dir = await makeTempDir(t, 'agenv-codex-installer-');
  const scriptPath = path.join(dir, 'install.sh');
  await fs.writeFile(scriptPath, FAKE_CODEX_INSTALLER, { mode: 0o755 });
  const tracePath = path.join(dir, 'trace.txt');
  return { scriptPath, tracePath };
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// claude --channel native
// ---------------------------------------------------------------------------

test('install claude --channel native downloads a verified binary into the profile', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');
  const server = await startClaudeServer(t);

  await runCli(['install', 'claude', '--channel', 'native'], {
    cwd,
    env: { AGENV_HOME: home, AGENV_CLAUDE_DOWNLOAD_BASE: server.base },
  });

  const binPath = path.join(home, 'agents', 'claude', 'agent', 'bin', 'claude');
  const stat = await fs.stat(binPath);
  assert.ok(stat.mode & 0o100, 'binary must be executable');
  assert.equal(await fs.readFile(binPath, 'utf8'), FAKE_CLAUDE_BIN);

  const metaRaw = await fs.readFile(
    path.join(home, 'agents', 'claude', 'profile.json'),
    'utf8',
  );
  assert.ok(metaRaw.endsWith('\n'));
  const meta = JSON.parse(metaRaw);
  assert.equal(meta.channel, 'native');
  assert.equal(meta.version, '3.2.1');
  assert.equal(meta.binPath, binPath);
  assert.equal(meta.pinned, false);
});

test('install claude --channel native --pin uses the pinned version and skips /latest', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');
  const server = await startClaudeServer(t, {
    latestVersion: '3.2.1',
    versions: ['2.0.0'],
  });

  await runCli(
    ['install', 'claude', 'old', '--channel', 'native', '--pin', '2.0.0'],
    {
      cwd,
      env: { AGENV_HOME: home, AGENV_CLAUDE_DOWNLOAD_BASE: server.base },
    },
  );

  const meta = await readJsonFile(
    path.join(home, 'agents', 'old', 'profile.json'),
  );
  assert.equal(meta.version, '2.0.0');
  assert.equal(meta.pinned, true);
  assert.ok(
    !server.requests.includes('/latest'),
    `pinned install must not resolve latest; requests: ${server.requests}`,
  );
});

test('install claude --channel native fails on checksum mismatch and leaves no binary', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');
  const server = await startClaudeServer(t, { badChecksum: true });

  await assert.rejects(
    runCli(['install', 'claude', '--channel', 'native'], {
      cwd,
      env: { AGENV_HOME: home, AGENV_CLAUDE_DOWNLOAD_BASE: server.base },
    }),
    (err) => /checksum/i.test(`${err.stderr}${err.stdout}`),
  );

  await assert.rejects(
    fs.access(path.join(home, 'agents', 'claude', 'agent', 'bin', 'claude')),
  );
});

test('run launches a native claude profile via its recorded binPath', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');
  const outputFile = path.join(
    await makeTempDir(t, 'agenv-out-'),
    'output.json',
  );
  const server = await startClaudeServer(t);

  await runCli(['install', 'claude', '--channel', 'native'], {
    cwd,
    env: { AGENV_HOME: home, AGENV_CLAUDE_DOWNLOAD_BASE: server.base },
  });
  await runCli(['run', 'claude', '--', '--hello'], {
    cwd,
    env: { AGENV_HOME: home, TEST_OUTPUT: outputFile },
  });

  const output = await readJsonFile(outputFile);
  assert.deepEqual(output.argv, ['--hello']);
  assert.equal(
    output.env.CLAUDE_CONFIG_DIR,
    path.join(home, 'agents', 'claude', 'config'),
  );
});

test('show --json reports channel and binPath for native profiles', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');
  const server = await startClaudeServer(t);

  await runCli(['install', 'claude', '--channel', 'native'], {
    cwd,
    env: { AGENV_HOME: home, AGENV_CLAUDE_DOWNLOAD_BASE: server.base },
  });
  const result = await runCli(['show', 'claude', '--json'], {
    cwd,
    env: { AGENV_HOME: home },
  });

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.channel, 'native');
  assert.equal(
    parsed.binPath,
    path.join(home, 'agents', 'claude', 'agent', 'bin', 'claude'),
  );
});

test('update re-installs a native claude profile to the new latest', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');
  const server = await startClaudeServer(t, {
    latestVersion: '3.2.1',
    versions: ['3.2.1', '4.0.0'],
  });

  await runCli(['install', 'claude', '--channel', 'native'], {
    cwd,
    env: { AGENV_HOME: home, AGENV_CLAUDE_DOWNLOAD_BASE: server.base },
  });

  await runCli(['update', 'claude', '--pin', '4.0.0'], {
    cwd,
    env: { AGENV_HOME: home, AGENV_CLAUDE_DOWNLOAD_BASE: server.base },
  });

  const meta = await readJsonFile(
    path.join(home, 'agents', 'claude', 'profile.json'),
  );
  assert.equal(meta.channel, 'native');
  assert.equal(meta.version, '4.0.0');
  assert.equal(meta.pinned, true);
});

// ---------------------------------------------------------------------------
// codex --channel native
// ---------------------------------------------------------------------------

test('install codex --channel native runs the installer with profile-scoped env', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');
  const { scriptPath, tracePath } = await writeFakeCodexInstaller(t);

  await runCli(['install', 'codex', '--channel', 'native'], {
    cwd,
    env: {
      AGENV_HOME: home,
      AGENV_CODEX_INSTALLER_PATH: scriptPath,
      AGENV_TEST_INSTALLER_TRACE: tracePath,
    },
  });

  const agentPath = path.join(home, 'agents', 'codex', 'agent');
  const trace = await fs.readFile(tracePath, 'utf8');
  assert.ok(
    trace.includes(`CODEX_HOME=${agentPath}`),
    `installer must receive profile CODEX_HOME; trace: ${trace}`,
  );
  assert.ok(trace.includes(`CODEX_INSTALL_DIR=${path.join(agentPath, 'bin')}`));
  assert.ok(/CODEX_NON_INTERACTIVE=(1|true)/.test(trace));

  const meta = await readJsonFile(
    path.join(home, 'agents', 'codex', 'profile.json'),
  );
  assert.equal(meta.channel, 'native');
  assert.equal(meta.binPath, path.join(agentPath, 'bin', 'codex'));
  // resolved by running `codex --version` on the installed binary
  assert.equal(meta.version, '9.9.9');
});

test('install codex --channel native --pin passes --release to the installer', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');
  const { scriptPath, tracePath } = await writeFakeCodexInstaller(t);

  await runCli(
    ['install', 'codex', 'pinned', '--channel', 'native', '--pin', '0.99.0'],
    {
      cwd,
      env: {
        AGENV_HOME: home,
        AGENV_CODEX_INSTALLER_PATH: scriptPath,
        AGENV_TEST_INSTALLER_TRACE: tracePath,
      },
    },
  );

  const trace = await fs.readFile(tracePath, 'utf8');
  assert.ok(
    trace.includes('ARGS=--release 0.99.0'),
    `installer must receive --release; trace: ${trace}`,
  );
  const meta = await readJsonFile(
    path.join(home, 'agents', 'pinned', 'profile.json'),
  );
  assert.equal(meta.pinned, true);
});

// ---------------------------------------------------------------------------
// unsupported combinations
// ---------------------------------------------------------------------------

test('install gemini --channel native errors clearly', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');

  await assert.rejects(
    runCli(['install', 'gemini', '--channel', 'native'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    (err) =>
      /native.*not supported.*gemini|gemini.*no native/i.test(err.stderr),
  );
});

test('install gemini --channel native must not destroy an existing npm profile', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');

  // simulate an existing npm-installed gemini profile
  const profilePath = path.join(home, 'agents', 'gemini');
  const marker = path.join(profilePath, 'agent', 'node_modules', 'marker.txt');
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, 'installed\n');
  await fs.writeFile(
    path.join(profilePath, 'profile.json'),
    `${JSON.stringify({
      profile: 'gemini',
      agent: 'gemini',
      package: '@google/gemini-cli',
      version: '1.0.0',
      pinned: false,
      channel: 'npm',
      installedAt: '2026-01-01T00:00:00.000Z',
    })}\n`,
  );

  await assert.rejects(
    runCli(['install', 'gemini', '--channel', 'native'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    (err) =>
      /native.*not supported.*gemini|gemini.*no native/i.test(err.stderr),
  );

  // the existing npm install must be untouched
  await fs.access(marker);
});

test('install rejects unknown --channel values', async (t) => {
  const home = await makeTempDir(t, 'agenv-home-');
  const cwd = await makeTempDir(t, 'agenv-proj-');

  await assert.rejects(
    runCli(['install', 'claude', '--channel', 'snap'], {
      cwd,
      env: { AGENV_HOME: home },
    }),
    (err) => /channel/i.test(err.stderr),
  );
});
