const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildProfileViews,
  loadTuiState,
  setProfileArgsArray,
  setProfileEnv,
  removeProfileEnv,
  claimProfileDefault,
  removeProfileSilent,
} = require('../dist/tui/actions');

async function makeTempDir(t, prefix) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
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

async function withTempCwd(t) {
  const dir = await makeTempDir(t, 'agenv-proj-');
  const saved = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(saved));
  return dir;
}

function emptyConfig() {
  return {
    defaultProfile: null,
    agentDefaults: {},
    profiles: {},
    path: null,
    sources: { defaultProfile: null, agentDefaults: {} },
  };
}

function record(profile, agent = 'codex') {
  return {
    profile,
    name: agent,
    package: 'fake-agent',
    version: '1.0.0',
    pinned: false,
    installedAt: '2026-01-01T00:00:00.000Z',
    profilePath: `/tmp/${profile}`,
    agentPath: `/tmp/${profile}/agent`,
    configPath: `/tmp/${profile}/config`,
  };
}

async function installFakeProfile(home, profile, agent = 'codex') {
  const profilePath = path.join(home, 'agents', profile);
  const agentPath = path.join(profilePath, 'agent');
  await fs.mkdir(agentPath, { recursive: true });
  await fs.writeFile(
    path.join(profilePath, 'profile.json'),
    `${JSON.stringify({ ...record(profile, agent), profilePath, agentPath, configPath: path.join(profilePath, 'config') }, null, 2)}\n`,
  );
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// buildProfileViews (pure)

function fixtureState() {
  const globalConfig = emptyConfig();
  globalConfig.defaultProfile = 'a';
  globalConfig.agentDefaults = { codex: 'a', claude: 'b' };
  globalConfig.profiles = {
    a: { hasArgs: true, args: "--foo 'x y'", env: { B: '2', A: '1' } },
  };

  const projectConfig = emptyConfig();
  projectConfig.defaultProfile = 'b';
  projectConfig.agentDefaults = { codex: 'b' };
  projectConfig.profiles = {
    a: { hasArgs: false, args: '', env: { C: '3' } },
  };

  const config = emptyConfig();
  config.defaultProfile = 'b';
  config.agentDefaults = { codex: 'b', claude: 'b' };
  config.profiles = {
    a: { hasArgs: true, args: "--foo 'x y'", env: { A: '1', B: '2', C: '3' } },
  };

  return {
    profiles: { b: record('b'), a: record('a'), c: record('c') },
    config,
    projectConfig,
    globalConfig,
  };
}

test('buildProfileViews: sorts profiles by name', () => {
  const views = buildProfileViews(fixtureState());
  assert.deepEqual(
    views.map((v) => v.profile),
    ['a', 'b', 'c'],
  );
});

test('buildProfileViews: scope views parse args and sort env keys', () => {
  const views = buildProfileViews(fixtureState());
  const a = views.find((v) => v.profile === 'a');

  assert.equal(a.global.hasArgs, true);
  assert.equal(a.global.args, "--foo 'x y'");
  assert.deepEqual(a.global.argsArray, ['--foo', 'x y']);
  assert.deepEqual(a.global.envKeys, ['A', 'B']);
  assert.deepEqual(a.project.envKeys, ['C']);
  assert.deepEqual(a.effective.envKeys, ['A', 'B', 'C']);
  assert.equal(a.project.hasArgs, false);
  assert.deepEqual(a.project.argsArray, []);
});

test('buildProfileViews: computes defaults per scope', () => {
  const views = buildProfileViews(fixtureState());
  const a = views.find((v) => v.profile === 'a');
  const b = views.find((v) => v.profile === 'b');

  // agents sorted alphabetically, then 'default' last
  assert.deepEqual(a.globalDefaults, ['codex', 'default']);
  assert.deepEqual(a.projectDefaults, []);
  assert.deepEqual(a.defaults, []);
  assert.deepEqual(b.globalDefaults, ['claude']);
  assert.deepEqual(b.projectDefaults, ['codex', 'default']);
  assert.deepEqual(b.defaults, ['claude', 'codex', 'default']);
});

test('buildProfileViews: marks global defaults shadowed by project config', () => {
  const views = buildProfileViews(fixtureState());
  const a = views.find((v) => v.profile === 'a');
  const b = views.find((v) => v.profile === 'b');

  // project sets codex and defaultProfile, so both global claims of "a" are shadowed
  assert.deepEqual(a.shadowedDefaults, ['codex', 'default']);
  // project does not set claude, so global claude claim of "b" stays visible
  assert.deepEqual(b.shadowedDefaults, []);
});

test('buildProfileViews: profile without config entries', () => {
  const views = buildProfileViews(fixtureState());
  const c = views.find((v) => v.profile === 'c');

  assert.equal(c.hasProjectEntry, false);
  assert.deepEqual(c.defaults, []);
  assert.deepEqual(c.global.envKeys, []);
  assert.equal(c.global.hasArgs, false);
});

test('buildProfileViews: hasProjectEntry via profiles or defaults', () => {
  const views = buildProfileViews(fixtureState());
  assert.equal(views.find((v) => v.profile === 'a').hasProjectEntry, true);
  assert.equal(views.find((v) => v.profile === 'b').hasProjectEntry, true);
});

// loadTuiState

test('loadTuiState: merges global and project config', async (t) => {
  const home = await withTempAgenvHome(t);
  const proj = await withTempCwd(t);

  await installFakeProfile(home, 'p1');
  await fs.writeFile(
    path.join(home, '.agenv.json'),
    `${JSON.stringify({ defaultProfile: 'p1' })}\n`,
  );
  await fs.writeFile(
    path.join(proj, '.agenv.json'),
    `${JSON.stringify({ defaultProfile: 'p2' })}\n`,
  );

  const state = await loadTuiState();
  assert.deepEqual(Object.keys(state.profiles), ['p1']);
  assert.equal(state.globalConfig.defaultProfile, 'p1');
  assert.equal(state.projectConfig.defaultProfile, 'p2');
  assert.equal(state.config.defaultProfile, 'p2');
});

// setProfileArgsArray

test('setProfileArgsArray: global scope writes AGENV_HOME/.agenv.json', async (t) => {
  const home = await withTempAgenvHome(t);
  await withTempCwd(t);

  await setProfileArgsArray('p1', 'global', ['--model', 'o3', 'b c']);

  const file = path.join(home, '.agenv.json');
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(raw.endsWith('\n'), 'config writes must end with a newline');
  const cfg = JSON.parse(raw);
  assert.equal(cfg.profiles.p1.args, "--model o3 'b c'");
});

test('setProfileArgsArray: project scope writes ./.agenv.json', async (t) => {
  await withTempAgenvHome(t);
  const proj = await withTempCwd(t);

  await setProfileArgsArray('p1', 'project', ['--fast']);

  const cfg = await readJsonFile(path.join(proj, '.agenv.json'));
  assert.equal(cfg.profiles.p1.args, '--fast');
});

test('setProfileArgsArray: empty array clears saved args', async (t) => {
  const home = await withTempAgenvHome(t);
  await withTempCwd(t);

  await setProfileArgsArray('p1', 'global', ['--fast']);
  await setProfileArgsArray('p1', 'global', []);

  const cfg = await readJsonFile(path.join(home, '.agenv.json'));
  assert.equal(cfg.profiles?.p1?.args, undefined);
});

// setProfileEnv / removeProfileEnv

test('setProfileEnv: adds an env entry', async (t) => {
  const home = await withTempAgenvHome(t);
  await withTempCwd(t);

  await setProfileEnv('p1', 'global', 'FOO=bar');

  const cfg = await readJsonFile(path.join(home, '.agenv.json'));
  assert.deepEqual(cfg.profiles.p1.env, { FOO: 'bar' });
});

test('setProfileEnv: replaceKey renames an existing entry', async (t) => {
  const home = await withTempAgenvHome(t);
  await withTempCwd(t);

  await setProfileEnv('p1', 'global', 'FOO=bar');
  await setProfileEnv('p1', 'global', 'BAZ=qux', 'FOO');

  const cfg = await readJsonFile(path.join(home, '.agenv.json'));
  assert.deepEqual(cfg.profiles.p1.env, { BAZ: 'qux' });
});

test('removeProfileEnv: removes an entry', async (t) => {
  const home = await withTempAgenvHome(t);
  await withTempCwd(t);

  await setProfileEnv('p1', 'global', 'FOO=bar');
  await setProfileEnv('p1', 'global', 'KEEP=1');
  await removeProfileEnv('p1', 'global', 'FOO');

  const cfg = await readJsonFile(path.join(home, '.agenv.json'));
  assert.deepEqual(cfg.profiles.p1.env, { KEEP: '1' });
});

test('removeProfileEnv: unknown key is a no-op and creates no file', async (t) => {
  const home = await withTempAgenvHome(t);
  await withTempCwd(t);

  await removeProfileEnv('p1', 'global', 'NOPE');

  await assert.rejects(fs.access(path.join(home, '.agenv.json')));
});

// claimProfileDefault

test('claimProfileDefault: default in global scope', async (t) => {
  const home = await withTempAgenvHome(t);
  await withTempCwd(t);

  await claimProfileDefault('p1', 'global', 'default');

  const cfg = await readJsonFile(path.join(home, '.agenv.json'));
  assert.equal(cfg.defaultProfile, 'p1');
});

test('claimProfileDefault: agent default in project scope', async (t) => {
  await withTempAgenvHome(t);
  const proj = await withTempCwd(t);

  await claimProfileDefault('p1', 'project', 'codex');

  const cfg = await readJsonFile(path.join(proj, '.agenv.json'));
  assert.deepEqual(cfg.agentDefaults, { codex: 'p1' });
});

test('claimProfileDefault: agent default in global scope', async (t) => {
  const home = await withTempAgenvHome(t);
  await withTempCwd(t);

  await claimProfileDefault('p1', 'global', 'claude');

  const cfg = await readJsonFile(path.join(home, '.agenv.json'));
  assert.deepEqual(cfg.agentDefaults, { claude: 'p1' });
});

// removeProfileSilent

test('removeProfileSilent: deletes profile dir and heals global defaults', async (t) => {
  const home = await withTempAgenvHome(t);
  await withTempCwd(t);

  await installFakeProfile(home, 'p1', 'codex');
  await installFakeProfile(home, 'p2', 'claude');
  await fs.writeFile(
    path.join(home, '.agenv.json'),
    `${JSON.stringify({ defaultProfile: 'p1', agentDefaults: { codex: 'p1', claude: 'p2' } })}\n`,
  );

  await removeProfileSilent('p1');

  await assert.rejects(fs.access(path.join(home, 'agents', 'p1')));
  const raw = await fs.readFile(path.join(home, '.agenv.json'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.ok(!raw.includes('p1'), `healed config still references p1: ${raw}`);
  const cfg = JSON.parse(raw);
  // heal: defaultProfile falls back to the oldest remaining profile, and the
  // codex claim is dropped because no codex profile remains
  assert.equal(cfg.defaultProfile, 'p2');
  assert.deepEqual(cfg.agentDefaults, { claude: 'p2' });
});
