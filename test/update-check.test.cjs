const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// isNewerVersion
// ---------------------------------------------------------------------------

test('isNewerVersion: basic comparisons', async () => {
  const { isNewerVersion } = await import(
    path.join(repoRoot, 'dist', 'updateCheck.js')
  );
  assert.equal(isNewerVersion('2.0.0', '1.0.0'), true);
  assert.equal(isNewerVersion('1.0.1', '1.0.0'), true);
  assert.equal(isNewerVersion('1.1.0', '1.0.9'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', '2.0.0'), false);
  assert.equal(isNewerVersion('0.121.0', '0.115.0'), true);
  assert.equal(isNewerVersion('0.115.0', '0.121.0'), false);
});

test('isNewerVersion: handles v prefix and prerelease', async () => {
  const { isNewerVersion } = await import(
    path.join(repoRoot, 'dist', 'updateCheck.js')
  );
  assert.equal(isNewerVersion('v2.0.0', '1.0.0'), true);
  assert.equal(isNewerVersion('2.0.0-beta.1', '1.0.0'), true);
  assert.equal(isNewerVersion('', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', ''), false);
});

// ---------------------------------------------------------------------------
// readInstalledVersion
// ---------------------------------------------------------------------------

test('readInstalledVersion: reads version from package.json', async () => {
  const { readInstalledVersion } = await import(
    path.join(repoRoot, 'dist', 'updateCheck.js')
  );
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-update-test-'));
  const pkgDir = path.join(tmp, 'node_modules', '@openai', 'codex');
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.115.0' }),
  );

  const version = await readInstalledVersion(tmp, '@openai/codex');
  assert.equal(version, '0.115.0');

  await fs.rm(tmp, { recursive: true, force: true });
});

test('readInstalledVersion: returns null for missing package', async () => {
  const { readInstalledVersion } = await import(
    path.join(repoRoot, 'dist', 'updateCheck.js')
  );
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-update-test-'));
  const version = await readInstalledVersion(tmp, '@openai/codex');
  assert.equal(version, null);
  await fs.rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeAgentAutoUpdateConfig
// ---------------------------------------------------------------------------

test('writeAgentAutoUpdateConfig: writes codex config.toml', async () => {
  const { writeAgentAutoUpdateConfig } = await import(
    path.join(repoRoot, 'dist', 'install.js')
  );
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-update-test-'));
  const configPath = path.join(tmp, 'config');
  await fs.mkdir(configPath, { recursive: true });

  await writeAgentAutoUpdateConfig('codex', configPath);

  const content = await fs.readFile(
    path.join(configPath, 'config.toml'),
    'utf8',
  );
  assert.match(content, /check_for_update_on_startup = false/);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('writeAgentAutoUpdateConfig: preserves existing codex config.toml content', async () => {
  const { writeAgentAutoUpdateConfig } = await import(
    path.join(repoRoot, 'dist', 'install.js')
  );
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-update-test-'));
  const configPath = path.join(tmp, 'config');
  await fs.mkdir(configPath, { recursive: true });

  await fs.writeFile(path.join(configPath, 'config.toml'), 'model = "o3"\n');

  await writeAgentAutoUpdateConfig('codex', configPath);

  const content = await fs.readFile(
    path.join(configPath, 'config.toml'),
    'utf8',
  );
  assert.match(content, /model = "o3"/);
  assert.match(content, /check_for_update_on_startup = false/);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('writeAgentAutoUpdateConfig: idempotent for codex', async () => {
  const { writeAgentAutoUpdateConfig } = await import(
    path.join(repoRoot, 'dist', 'install.js')
  );
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-update-test-'));
  const configPath = path.join(tmp, 'config');
  await fs.mkdir(configPath, { recursive: true });

  await writeAgentAutoUpdateConfig('codex', configPath);
  await writeAgentAutoUpdateConfig('codex', configPath);

  const content = await fs.readFile(
    path.join(configPath, 'config.toml'),
    'utf8',
  );
  const matches = content.match(/check_for_update_on_startup/g);
  assert.equal(matches.length, 1);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('writeAgentAutoUpdateConfig: writes gemini settings.json', async () => {
  const { writeAgentAutoUpdateConfig } = await import(
    path.join(repoRoot, 'dist', 'install.js')
  );
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-update-test-'));
  const configPath = path.join(tmp, 'config');
  await fs.mkdir(configPath, { recursive: true });

  await writeAgentAutoUpdateConfig('gemini', configPath);

  const content = JSON.parse(
    await fs.readFile(
      path.join(configPath, '.gemini', 'settings.json'),
      'utf8',
    ),
  );
  assert.equal(content.general.enableAutoUpdateNotification, false);
  assert.equal(content.general.enableAutoUpdate, false);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('writeAgentAutoUpdateConfig: preserves existing gemini settings', async () => {
  const { writeAgentAutoUpdateConfig } = await import(
    path.join(repoRoot, 'dist', 'install.js')
  );
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-update-test-'));
  const configPath = path.join(tmp, 'config');
  const geminiDir = path.join(configPath, '.gemini');
  await fs.mkdir(geminiDir, { recursive: true });

  await fs.writeFile(
    path.join(geminiDir, 'settings.json'),
    JSON.stringify({ general: { theme: 'dark' }, other: true }, null, 2),
  );

  await writeAgentAutoUpdateConfig('gemini', configPath);

  const content = JSON.parse(
    await fs.readFile(path.join(geminiDir, 'settings.json'), 'utf8'),
  );
  assert.equal(content.general.theme, 'dark');
  assert.equal(content.general.enableAutoUpdateNotification, false);
  assert.equal(content.general.enableAutoUpdate, false);
  assert.equal(content.other, true);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('writeAgentAutoUpdateConfig: no-op for claude', async () => {
  const { writeAgentAutoUpdateConfig } = await import(
    path.join(repoRoot, 'dist', 'install.js')
  );
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-update-test-'));
  const configPath = path.join(tmp, 'config');
  await fs.mkdir(configPath, { recursive: true });

  await writeAgentAutoUpdateConfig('claude', configPath);

  const entries = await fs.readdir(configPath);
  assert.equal(entries.length, 0);

  await fs.rm(tmp, { recursive: true, force: true });
});
