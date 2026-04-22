import fs from 'node:fs/promises';
import path from 'node:path';
import { getGlobalConfigFile, readJson } from './state';
import {
  ensureInstalled,
  findAgentBinary,
  profilePaths,
  runCommand,
  writeAgentAutoUpdateConfig,
} from './install';
import { maybeNotifySelfUpdate } from './selfUpdate';
import {
  readInstalledVersion,
  fetchLatestVersion,
  isNewerVersion,
  askUserToUpdate,
} from './updateCheck';
import {
  SUPPORTED_AGENTS,
  DEFAULT_ENV,
  normalizeAgentName,
  normalizeProfileName,
  assertSupportedAgent,
  assertValidProfileName,
  resolvePackageName,
  parseArgsString,
  envVarForAgent,
  stringifyArgs,
  getYoloArgs,
} from './agents';
import { createUserError } from './errors';
import {
  loadGlobalConfig,
  loadResolvedConfig,
  writeConfigFile,
  localConfigPath,
  loadOrCreateLocalConfig,
  healGlobalDefaults,
  updateProfileConfig,
  parseEnvPairs,
} from './config';
import {
  readInstalledProfiles,
  resolveProfileRecord,
  resolveProfileNameDetailed,
  resolveProfileForAgentDetailed,
  getResolvedProfileSettings,
} from './resolution';
import { runTuiApp } from './tui';
import type { AgenvConfig, ProfileRecord, ResolvedProfile } from './types';

function commandUsesDelimiter(commandName: string | string[]): boolean {
  const commandNames = new Set(
    Array.isArray(commandName) ? commandName : [commandName],
  );
  const argv = process.argv.slice(2);
  const invokedCommand = argv[0];
  if (!commandNames.has(invokedCommand)) return false;
  return argv.slice(1).includes('--');
}

function assertSavedArgsDelimiter(
  commandName: string | string[],
  savedArgs: string[],
) {
  if (!Array.isArray(savedArgs) || savedArgs.length === 0) return;
  if (commandUsesDelimiter(commandName)) return;
  throw createUserError('Saved args must be passed after "--".', {
    seeCommand: Array.isArray(commandName) ? commandName[0] : commandName,
  });
}

async function parseEnvFile(filePath: string): Promise<string[]> {
  const resolved = path.resolve(filePath);
  let content: string;
  try {
    content = await fs.readFile(resolved, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw createUserError(`Env file not found: ${resolved}`);
    }
    throw err;
  }

  const pairs: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    pairs.push(`${key}=${value}`);
  }
  return pairs;
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

async function resolveAccount(record: ProfileRecord): Promise<string> {
  if (record.name === 'codex') {
    const authPath = path.join(record.configPath, 'auth.json');
    const auth = (await readJson(authPath, null)) as Record<
      string,
      unknown
    > | null;
    if (!auth || typeof auth !== 'object') return '-';
    const tokens = auth.tokens as Record<string, unknown> | undefined;
    const email = decodeJwtPayload(tokens?.id_token)?.email;
    if (email && typeof email === 'string') {
      return email;
    }
    const accountId = tokens?.account_id;
    if (accountId && typeof accountId === 'string') {
      return accountId;
    }
  }
  if (record.name === 'claude') {
    const claudePath = path.join(record.configPath, '.claude.json');
    const claudeConfig = (await readJson(claudePath, null)) as Record<
      string,
      unknown
    > | null;
    const oauthAccount = claudeConfig?.oauthAccount as
      | Record<string, unknown>
      | undefined;
    const email = oauthAccount?.emailAddress;
    if (email && typeof email === 'string') {
      return email;
    }
    const accountUuid = oauthAccount?.accountUuid;
    if (accountUuid && typeof accountUuid === 'string') {
      return accountUuid;
    }
  }
  if (record.name === 'gemini') {
    const accountsPath = path.join(
      record.configPath,
      '.gemini',
      'google_accounts.json',
    );
    const accounts = (await readJson(accountsPath, null)) as Record<
      string,
      unknown
    > | null;
    const activeEmail = accounts?.active;
    if (activeEmail && typeof activeEmail === 'string') {
      return activeEmail;
    }

    const oauthPath = path.join(
      record.configPath,
      '.gemini',
      'oauth_creds.json',
    );
    const oauth = (await readJson(oauthPath, null)) as Record<
      string,
      unknown
    > | null;
    const email = decodeJwtPayload(oauth?.id_token)?.email;
    if (email && typeof email === 'string') {
      return email;
    }
  }
  return '-';
}

interface JsonRecord {
  profile: string;
  agent: string;
  version: string;
  pinned: boolean;
  package: string;
  path: string;
  agentPath: string;
  binPath: string | null;
  configPath: string;
  account: string;
  args: string;
  localArgs: string;
  resolves: string[];
}

async function toJsonRecord(
  record: ProfileRecord,
  {
    resolvedArgs,
    localArgs,
    resolves,
    account,
  }: {
    resolvedArgs: string;
    localArgs: string;
    resolves: string[];
    account: string;
  },
): Promise<JsonRecord> {
  const binPath = await findAgentBinary(record.agentPath, record.package);
  return {
    profile: record.profile,
    agent: record.name,
    version: record.version,
    pinned: record.pinned,
    package: record.package,
    path: record.profilePath,
    agentPath: record.agentPath,
    binPath: binPath || null,
    configPath: record.configPath,
    account: account || '-',
    args: resolvedArgs || '',
    localArgs: localArgs || '',
    resolves,
  };
}

async function installAction(
  agentSpec: string,
  profileArg: string | undefined,
  savedArgs: string[],
  options: {
    env?: string[];
    envFile?: string;
    force?: boolean;
    yolo?: boolean;
    pin?: string;
  },
) {
  assertSavedArgsDelimiter(['install', 'i'], savedArgs);
  if (options.envFile) {
    const fileEnv = await parseEnvFile(options.envFile);
    options.env = [...fileEnv, ...(options.env || [])];
  }
  const profiles = await readInstalledProfiles();
  const name = normalizeAgentName(agentSpec);
  assertSupportedAgent(name);

  const effectiveSavedArgs = options.yolo
    ? [...getYoloArgs(name), ...savedArgs]
    : savedArgs;
  if (options.yolo) {
    console.log(
      `Yolo mode: adding "${getYoloArgs(name).join(' ')}" to saved args.`,
    );
  }

  const profile = normalizeProfileName(profileArg) || name;
  assertValidProfileName(profile);
  const globalConfig = await loadGlobalConfig();

  const existing = profiles[profile];
  if (existing && !options.force) {
    if (existing.name !== name) {
      throw createUserError(
        `Profile "${profile}" is already installed for agent "${existing.name}". Choose another profile name.
agenv install ${name} <profile>`,
        { seeCommand: 'install' },
      );
    }
    const healed = healGlobalDefaults(globalConfig, profiles);
    if (healed.changed) {
      await writeConfigFile(globalConfig, getGlobalConfigFile());
    }
    console.log(
      `Profile "${profile}" already exists. No install was performed.`,
    );
    console.log(`- Reinstall: agenv install ${name} ${profile} --force`);
    console.log(`- Install another profile: agenv install ${name} <profile>`);
    console.log(`- Set global default: agenv default global ${profile}`);
    console.log(`- Edit global settings: agenv edit global ${profile}`);
    console.log(`- Edit local settings: agenv edit local ${profile}`);
    return;
  }
  if (existing && existing.name !== name) {
    throw createUserError(
      `Profile "${profile}" is already installed for agent "${existing.name}". Choose another profile name, or remove it first.
- Install to a different profile: agenv install ${name} <profile>
- Remove existing: agenv remove ${profile}`,
      { seeCommand: 'install' },
    );
  }

  const pkg = resolvePackageName(name, existing?.package);

  const pinVersion = options.pin;
  if (pinVersion === 'latest') {
    throw createUserError(
      'Pin version must be a concrete version, e.g. 0.1.2. Omit --pin to track latest.',
      { seeCommand: 'install' },
    );
  }
  const target = {
    profile,
    name,
    package: pkg,
    version: pinVersion || existing?.version || 'latest',
    pinned: Boolean(pinVersion),
    ...profilePaths(profile),
  };

  const { meta, installed } = await ensureInstalled(target, {
    force: Boolean(options.force),
  });
  await writeAgentAutoUpdateConfig(
    name,
    target.configPath || profilePaths(profile).configPath,
  );

  const agentDefaultEnv = DEFAULT_ENV[name] || {};
  const defaultEnvPairs = Object.entries(agentDefaultEnv).map(
    ([k, v]) => `${k}=${v}`,
  );
  const mergedEnv = [
    ...defaultEnvPairs,
    ...(Array.isArray(options.env)
      ? options.env
      : options.env
        ? [options.env]
        : []),
  ];

  const update = updateProfileConfig(globalConfig, profile, {
    savedArgs: effectiveSavedArgs,
    envInput: mergedEnv.length > 0 ? mergedEnv : undefined,
  });
  const updatedProfiles = await readInstalledProfiles();
  const healed = healGlobalDefaults(globalConfig, updatedProfiles);

  if (update.changed || healed.changed) {
    await writeConfigFile(globalConfig, getGlobalConfigFile());
  }

  console.log(
    installed
      ? `Installed profile "${profile}" (${meta.agent}@${meta.version})`
      : `Profile "${profile}" already up to date.`,
  );
}

async function updateAction(profileArg: string, options: { pin?: string }) {
  const profiles = await readInstalledProfiles();
  const profile = normalizeProfileName(profileArg);
  assertValidProfileName(profile);
  const current = resolveProfileRecord(profile, profiles, {
    seeCommand: 'update',
  });

  const explicitVersion = options.pin;
  if (explicitVersion === 'latest') {
    throw createUserError(
      'Pin version must be a concrete version, e.g. 0.1.2. Omit --pin to track latest.',
      { seeCommand: 'update' },
    );
  }
  const targetVersion = explicitVersion || 'latest';
  const target = {
    ...current,
    version: targetVersion,
    pinned: Boolean(explicitVersion),
  };
  if (target.version === current.version && target.pinned === current.pinned) {
    console.log(
      `Profile "${profile}" is already at requested version "${target.version}".`,
    );
    console.log(`- Inspect profile: agenv show ${profile}`);
    if (target.pinned) {
      console.log(`- Unpin and update to latest: agenv update ${profile}`);
    }
    return;
  }
  const { meta } = await ensureInstalled(target, {
    force: true,
  });
  const pinnedLabel = meta.pinned ? ' (pinned)' : '';
  console.log(
    `Updated profile "${profile}" to ${meta.agent}@${meta.version}${pinnedLabel}`,
  );
  if (current.pinned && !meta.pinned) {
    console.log(`Pin removed for profile "${profile}".`);
  }
}

async function removeAction(profileArg: string) {
  const profiles = await readInstalledProfiles();
  const profile = normalizeProfileName(profileArg);
  assertValidProfileName(profile);
  const current = resolveProfileRecord(profile, profiles, {
    seeCommand: 'remove',
  });

  await fs.rm(current.profilePath, { recursive: true, force: true });
  const remainingProfiles = await readInstalledProfiles();
  const globalConfig = await loadGlobalConfig();
  const healed = healGlobalDefaults(globalConfig, remainingProfiles);
  if (healed.changed) {
    await writeConfigFile(globalConfig, getGlobalConfigFile());
  }
  console.log(`Removed profile "${profile}"`);
}

async function listAction(options: { json?: boolean }) {
  const profiles = await readInstalledProfiles();
  const { config, nearestProjectConfig } = await loadResolvedConfig(
    process.cwd(),
    profiles,
  );

  const records = Object.values(profiles).sort((a, b) =>
    a.profile.localeCompare(b.profile),
  );

  const accountsByProfile: Record<string, string> = {};
  await Promise.all(
    records.map(async (record) => {
      accountsByProfile[record.profile] = await resolveAccount(record);
    }),
  );

  let defaultResolved: string | null = null;
  if (records.length) {
    try {
      defaultResolved = resolveProfileNameDetailed(null, {
        config,
        profiles,
      }).profile;
    } catch {
      defaultResolved = null;
    }
  }

  const installedAgents = new Set(records.map((r) => r.name));
  const agentResolved = new Map<string, string>();
  for (const agent of installedAgents) {
    try {
      const r = resolveProfileForAgentDetailed(agent, { config, profiles });
      agentResolved.set(agent, r.profile);
    } catch {
      // unresolved (multiple profiles, no agent default) — leave unset
    }
  }

  function resolvesFor(record: ProfileRecord): string[] {
    const tags: string[] = [];
    if (agentResolved.get(record.name) === record.profile) {
      tags.push(record.name);
    }
    if (defaultResolved === record.profile) {
      tags.push('default');
    }
    return tags;
  }

  if (options.json) {
    const rows = await Promise.all(
      records.map((record) => {
        const resolvedSettings = getResolvedProfileSettings(
          config,
          record.profile,
        );
        const localSettings = nearestProjectConfig.profiles?.[record.profile];
        return toJsonRecord(record, {
          resolvedArgs: resolvedSettings.args,
          localArgs: localSettings?.hasArgs ? localSettings.args : '',
          resolves: resolvesFor(record),
          account: accountsByProfile[record.profile],
        });
      }),
    );

    console.log(
      JSON.stringify(
        {
          profiles: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!records.length) {
    console.log('No profiles installed yet. Try `agenv install codex`.');
    return;
  }

  const columns = ['profile', 'agent', 'version', 'path', 'account', 'default'];
  const rows = records.map((record) => [
    record.profile,
    record.name,
    `v${record.version}${record.pinned ? ' (pinned)' : ''}`,
    record.profilePath,
    accountsByProfile[record.profile] || '-',
    resolvesFor(record).join(', ') || '-',
  ]);

  const widths = columns.map((name, index) =>
    Math.max(name.length, ...rows.map((row) => row[index].length)),
  );
  const renderRow = (row: string[]) =>
    row.map((value, index) => value.padEnd(widths[index])).join(' ');

  console.log(renderRow(columns));
  for (const row of rows) {
    console.log(renderRow(row));
  }
}

const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
const REDACT_EDGE_CHARS = 3;
const REDACT_MIN_LENGTH = 2 * REDACT_EDGE_CHARS + 6;

function redactEnvValue(key: string, value: string, reveal: boolean): string {
  if (reveal) return value;
  if (!SECRET_KEY_PATTERN.test(key)) return value;
  if (value.length < REDACT_MIN_LENGTH) return '***';
  return `${value.slice(0, REDACT_EDGE_CHARS)}***${value.slice(-REDACT_EDGE_CHARS)}`;
}

function redactedEnv(
  env: Record<string, string>,
  reveal: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = redactEnvValue(k, v, reveal);
  }
  return out;
}

function hasRedactableEnv(...envs: Array<Record<string, string> | undefined>) {
  for (const env of envs) {
    if (!env) continue;
    if (Object.keys(env).some((k) => SECRET_KEY_PATTERN.test(k))) return true;
  }
  return false;
}

interface HoldEntry {
  label: string;
  isOverall: boolean;
  agent?: string;
}

function holdsList(scope: AgenvConfig, profile: string): HoldEntry[] {
  const out: HoldEntry[] = [];
  if (scope.defaultProfile === profile) {
    out.push({ label: 'overall', isOverall: true });
  }
  for (const [agent, p] of Object.entries(scope.agentDefaults || {})) {
    if (p === profile) {
      out.push({ label: agent, isOverall: false, agent });
    }
  }
  return out;
}

function shadowedHoldsInGlobal(
  globalScope: AgenvConfig,
  projectScope: AgenvConfig,
  profile: string,
): { overall: boolean; agents: Set<string> } {
  const result = { overall: false, agents: new Set<string>() };
  if (
    globalScope.defaultProfile === profile &&
    projectScope.defaultProfile !== null
  ) {
    result.overall = true;
  }
  for (const [agent, p] of Object.entries(globalScope.agentDefaults || {})) {
    if (p === profile && projectScope.agentDefaults?.[agent] !== undefined) {
      result.agents.add(agent);
    }
  }
  return result;
}

function humanizeSource(source: string): string {
  if (source === 'project.defaultProfile') return 'project overall default';
  if (source === 'global.defaultProfile') return 'global overall default';
  if (source.startsWith('project.agentDefaults.')) {
    return `project ${source.split('.').pop()} default`;
  }
  if (source.startsWith('global.agentDefaults.')) {
    return `global ${source.split('.').pop()} default`;
  }
  if (source === 'single.profile') return 'single profile fallback';
  if (source === 'single.agent-profile') return 'single agent profile fallback';
  return source;
}

interface SelectedBy {
  selector: string;
  source: string;
}

function computeSelectedBy(
  profile: string,
  agent: string,
  profiles: Record<string, ProfileRecord>,
  config: AgenvConfig,
): SelectedBy[] {
  const out: SelectedBy[] = [];
  try {
    const r = resolveProfileNameDetailed(null, { config, profiles });
    if (r.profile === profile) {
      out.push({
        selector: 'agenv run',
        source: humanizeSource(r.source ?? 'unknown'),
      });
    }
  } catch {
    // ambiguous, no profiles, etc.
  }
  try {
    const r = resolveProfileForAgentDetailed(agent, { config, profiles });
    if (r.profile === profile) {
      out.push({
        selector: `agenv run ${agent}`,
        source: humanizeSource(r.source ?? 'unknown'),
      });
    }
  } catch {
    // ambiguous, no agent profiles, etc.
  }
  return out;
}

interface ScopeShadow {
  args: boolean;
  envKeys: Set<string>;
  overallHold: boolean;
  agentHolds: Set<string>;
}

function formatScopeLines(
  label: string,
  scope: AgenvConfig,
  profile: string,
  shadow: ScopeShadow,
  reveal: boolean,
): string[] {
  const lines: string[] = [];
  if (!scope.path) {
    lines.push(`${label}: (no project config in this directory)`);
    return lines;
  }

  lines.push(`${label} (${scope.path}):`);
  const profileConfig = scope.profiles?.[profile];

  if (profileConfig?.hasArgs) {
    const value = profileConfig.args || '(empty)';
    lines.push(`  args:    ${value}${shadow.args ? '   [shadowed]' : ''}`);
  } else {
    lines.push('  args:    -');
  }

  const envKeys = Object.keys(profileConfig?.env || {}).sort();
  if (envKeys.length === 0) {
    lines.push('  env:     -');
  } else {
    lines.push('  env:');
    for (const k of envKeys) {
      const v = profileConfig?.env?.[k] ?? '';
      const displayed = redactEnvValue(k, v, reveal);
      const shadowed = shadow.envKeys.has(k) ? '   [shadowed]' : '';
      lines.push(`    ${k}=${displayed}${shadowed}`);
    }
  }

  const holds = holdsList(scope, profile);
  if (holds.length === 0) {
    lines.push('  default: -');
  } else {
    const items = holds.map((h) => {
      const isShadowed = h.isOverall
        ? shadow.overallHold
        : h.agent !== undefined && shadow.agentHolds.has(h.agent);
      return isShadowed ? `${h.label} [shadowed]` : h.label;
    });
    lines.push(`  default: ${items.join(', ')}`);
  }

  return lines;
}

function formatInstalledDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

async function showAction(
  profileArg: string | undefined,
  options: { json?: boolean; reveal?: boolean },
) {
  const profiles = await readInstalledProfiles();
  const { config, nearestProjectConfig } = await loadResolvedConfig(
    process.cwd(),
    profiles,
  );

  if (!profileArg) {
    const available = Object.keys(profiles);
    const lines = ['Specify a profile to show.'];
    if (available.length) {
      lines.push(`Available profiles: ${available.join(', ')}`);
    } else {
      lines.push(
        'No profiles installed. Run `agenv install <agent>` to get started.',
      );
    }
    lines.push('To install: agenv install <agent> <profile>');
    throw createUserError(lines.join('\n'), { seeCommand: 'show' });
  }

  const profile = normalizeProfileName(profileArg);
  assertValidProfileName(profile);
  const record = resolveProfileRecord(profile, profiles, {
    seeCommand: 'show',
  });

  const reveal = Boolean(options.reveal);
  const globalConfig = await loadGlobalConfig();
  const projectConfig = nearestProjectConfig;
  const projectProfile = projectConfig.profiles?.[profile];
  const globalProfile = globalConfig.profiles?.[profile];

  const projectArgsSet = Boolean(projectProfile?.hasArgs);
  const globalArgsShadowed = projectArgsSet && Boolean(globalProfile?.hasArgs);
  const projectEnvKeys = new Set(Object.keys(projectProfile?.env || {}));
  const globalShadowedEnv = new Set(
    Object.keys(globalProfile?.env || {}).filter((k) => projectEnvKeys.has(k)),
  );
  const shadowHolds = shadowedHoldsInGlobal(
    globalConfig,
    projectConfig,
    profile,
  );

  const projectShadow: ScopeShadow = {
    args: false,
    envKeys: new Set<string>(),
    overallHold: false,
    agentHolds: new Set<string>(),
  };
  const globalShadow: ScopeShadow = {
    args: globalArgsShadowed,
    envKeys: globalShadowedEnv,
    overallHold: shadowHolds.overall,
    agentHolds: shadowHolds.agents,
  };

  const resolvedSettings = getResolvedProfileSettings(config, profile);
  const selectedBy = computeSelectedBy(profile, record.name, profiles, config);
  const resolves: string[] = [];
  if (selectedBy.some((s) => s.selector === `agenv run ${record.name}`)) {
    resolves.push(record.name);
  }
  if (selectedBy.some((s) => s.selector === 'agenv run')) {
    resolves.push('default');
  }

  if (options.json) {
    const account = await resolveAccount(record);
    const projectScopeJson = projectConfig.path
      ? {
          configPath: projectConfig.path,
          args: projectProfile?.hasArgs ? projectProfile.args : null,
          env: redactedEnv(projectProfile?.env || {}, reveal),
          defaults: holdsList(projectConfig, profile).map((h) => h.label),
        }
      : null;
    const globalScopeJson = {
      configPath: globalConfig.path,
      args: globalProfile?.hasArgs ? globalProfile.args : null,
      env: redactedEnv(globalProfile?.env || {}, reveal),
      defaults: holdsList(globalConfig, profile).map((h) => h.label),
      shadowed: {
        args: globalShadow.args,
        envKeys: Array.from(globalShadow.envKeys).sort(),
        defaults: [
          ...(globalShadow.overallHold ? ['overall'] : []),
          ...Array.from(globalShadow.agentHolds).sort(),
        ],
      },
    };
    const recordJson = await toJsonRecord(record, {
      resolvedArgs: resolvedSettings.args,
      localArgs: projectProfile?.hasArgs ? projectProfile.args : '',
      resolves,
      account,
    });
    console.log(
      JSON.stringify(
        {
          ...recordJson,
          envRevealed: reveal,
          installedAt: record.installedAt,
          scopes: {
            project: projectScopeJson,
            global: globalScopeJson,
          },
          selectedBy,
        },
        null,
        2,
      ),
    );
    return;
  }

  const account = await resolveAccount(record);
  const lines: string[] = [];
  lines.push(`Profile: ${record.profile}`);
  lines.push(
    `Agent: ${record.name}@${record.version}${record.pinned ? ' (pinned)' : ''}`,
  );
  lines.push(`Package: ${record.package}`);
  lines.push(`Path: ${record.profilePath}`);
  lines.push(`Config: ${record.configPath}`);
  lines.push(`Account: ${account}`);
  lines.push(`Installed: ${formatInstalledDate(record.installedAt)}`);
  lines.push('');

  lines.push(
    ...formatScopeLines(
      'Project scope',
      projectConfig,
      profile,
      projectShadow,
      reveal,
    ),
  );
  lines.push('');
  lines.push(
    ...formatScopeLines(
      'Global scope',
      globalConfig,
      profile,
      globalShadow,
      reveal,
    ),
  );
  lines.push('');

  lines.push('Effective in this directory:');
  lines.push(`  args:    ${resolvedSettings.args || '-'}`);
  const effectiveEnvKeys = Object.keys(resolvedSettings.env).sort();
  lines.push(
    `  env keys: ${effectiveEnvKeys.length ? effectiveEnvKeys.join(', ') : '-'}`,
  );
  if (selectedBy.length === 0) {
    lines.push('  selected by: (this profile is not the active default)');
  } else {
    lines.push('  selected by:');
    for (const sb of selectedBy) {
      lines.push(`    ${sb.selector}   (${sb.source})`);
    }
  }

  if (!reveal && hasRedactableEnv(projectProfile?.env, globalProfile?.env)) {
    lines.push('');
    lines.push(
      'Note: env values for keys matching *KEY/*TOKEN/*SECRET/*PASSWORD redacted; pass --reveal to show.',
    );
  }

  console.log(lines.join('\n'));
}

async function editConfigAction(
  profileArg: string,
  savedArgs: string[],
  options: {
    env?: string[];
    envFile?: string;
  },
  scope: 'global' | 'local',
) {
  const commandName = `edit ${scope}`;
  assertSavedArgsDelimiter(['edit'], savedArgs);
  if (options.envFile) {
    const fileEnv = await parseEnvFile(options.envFile);
    options.env = [...fileEnv, ...(options.env || [])];
  }

  const profiles = await readInstalledProfiles();
  const profile = normalizeProfileName(profileArg);
  assertValidProfileName(profile);

  const targetPath =
    scope === 'global' ? getGlobalConfigFile() : localConfigPath();
  const config =
    scope === 'global'
      ? await loadGlobalConfig()
      : await loadOrCreateLocalConfig(targetPath);

  resolveProfileRecord(profile, profiles, { seeCommand: commandName });

  const update = updateProfileConfig(config, profile, {
    savedArgs,
    envInput: options.env,
  });

  if (!update.changed) {
    console.log(`No changes applied to profiles.${profile}.`);
    console.log('');
    console.log('Usage:');
    console.log(
      `  agenv edit ${scope} ${profile} --env KEY=VALUE          # set env var`,
    );
    console.log(
      `  agenv edit ${scope} ${profile} -- --model gpt-5         # set saved args`,
    );
    console.log(
      `  agenv default ${scope} ${profile}                       # set as default`,
    );
    return;
  }

  await writeConfigFile(config, targetPath);

  const argsText = update.savedArgsApplied
    ? ` set args="${stringifyArgs(savedArgs)}"`
    : '';
  const envText = update.envKeys.length
    ? ` set env keys=[${update.envKeys.join(', ')}]`
    : '';

  console.log(
    `Updated profiles.${profile} in ${targetPath}:${argsText}${envText}`,
  );
}

async function editAction(
  scopeArg: string | undefined,
  profileArg: string | undefined,
  savedArgs: string[],
  options: {
    env?: string[];
    envFile?: string;
  },
) {
  if (!scopeArg) {
    throw createUserError(
      'Specify a scope: "local" or "global".\nExample: agenv edit local <profile> --env FOO=bar',
      { seeCommand: 'edit' },
    );
  }
  const scope = scopeArg.toLowerCase();
  if (scope !== 'global' && scope !== 'local') {
    throw createUserError(
      `Invalid scope "${scopeArg}". Must be "local" or "global".`,
      { seeCommand: 'edit' },
    );
  }
  if (!profileArg) {
    const profiles = await readInstalledProfiles();
    const available = Object.keys(profiles);
    const lines = [`Specify a profile to edit (${scope}).`];
    if (available.length) {
      lines.push(`Available profiles: ${available.join(', ')}`);
    } else {
      lines.push(
        'No profiles installed. Run `agenv install <agent>` to get started.',
      );
    }
    throw createUserError(lines.join('\n'), { seeCommand: 'edit' });
  }
  return editConfigAction(profileArg, savedArgs, options, scope);
}

async function defaultAction(
  scopeArg: string | undefined,
  profileArg: string | undefined,
  options: { for?: string },
) {
  if (!scopeArg) {
    throw createUserError(
      'Specify a scope: "local" or "global".\nExample: agenv default local <profile>',
      { seeCommand: 'default' },
    );
  }
  const scope = scopeArg.toLowerCase();
  if (scope !== 'global' && scope !== 'local') {
    throw createUserError(
      `Invalid scope "${scopeArg}". Must be "local" or "global".`,
      { seeCommand: 'default' },
    );
  }

  const profiles = await readInstalledProfiles();
  if (!profileArg) {
    const available = Object.keys(profiles);
    const lines = [`Specify a profile to set as the ${scope} default.`];
    if (available.length) {
      lines.push(`Available profiles: ${available.join(', ')}`);
    } else {
      lines.push(
        'No profiles installed. Run `agenv install <agent>` to get started.',
      );
    }
    throw createUserError(lines.join('\n'), { seeCommand: 'default' });
  }
  const profile = normalizeProfileName(profileArg);
  assertValidProfileName(profile);

  const targetPath =
    scope === 'global' ? getGlobalConfigFile() : localConfigPath();
  const config =
    scope === 'global'
      ? await loadGlobalConfig()
      : await loadOrCreateLocalConfig(targetPath);

  resolveProfileRecord(profile, profiles, { seeCommand: 'default' });

  const updateOptions: { setDefault?: boolean; agent?: string | null } = {};
  let what: string;
  if (options.for) {
    const agent = normalizeAgentName(options.for);
    assertSupportedAgent(agent);
    const record = resolveProfileRecord(profile, profiles, {
      seeCommand: 'default',
    });
    if (record.name !== agent) {
      throw createUserError(
        `Profile "${profile}" is installed for agent "${record.name}", not "${agent}".`,
        { seeCommand: 'default' },
      );
    }
    updateOptions.agent = agent;
    what = `default for agent "${agent}"`;
  } else {
    updateOptions.setDefault = true;
    what = 'overall default';
  }

  const update = updateProfileConfig(config, profile, updateOptions);

  if (!update.changed) {
    console.log(`Already set: profiles.${profile} is the ${scope} ${what}.`);
    return;
  }

  await writeConfigFile(config, targetPath);
  console.log(
    `Set profiles.${profile} as the ${scope} ${what} in ${targetPath}.`,
  );
}

async function cloneAction(sourceArg: string, targetArg: string) {
  const profiles = await readInstalledProfiles();
  const sourceProfile = normalizeProfileName(sourceArg);
  assertValidProfileName(sourceProfile);
  const sourceRecord = resolveProfileRecord(sourceProfile, profiles, {
    seeCommand: 'clone',
  });

  const targetProfile = normalizeProfileName(targetArg);
  assertValidProfileName(targetProfile);

  if (profiles[targetProfile]) {
    throw createUserError(
      `Profile "${targetProfile}" already exists. Choose a different name or remove it first.`,
      { seeCommand: 'clone' },
    );
  }

  const target = {
    profile: targetProfile,
    name: sourceRecord.name,
    package: sourceRecord.package,
    version: sourceRecord.version,
    pinned: sourceRecord.pinned,
    ...profilePaths(targetProfile),
  };

  await ensureInstalled(target, { force: false });
  await writeAgentAutoUpdateConfig(
    sourceRecord.name,
    target.configPath || profilePaths(targetProfile).configPath,
  );

  const globalConfig = await loadGlobalConfig();
  const sourceSettings = globalConfig.profiles?.[sourceProfile];
  if (sourceSettings) {
    const targetSettings = { ...sourceSettings };
    targetSettings.env = { ...sourceSettings.env };
    globalConfig.profiles[targetProfile] = targetSettings;
  }

  const updatedProfiles = await readInstalledProfiles();
  healGlobalDefaults(globalConfig, updatedProfiles);
  await writeConfigFile(globalConfig, getGlobalConfigFile());

  console.log(
    `Cloned "${sourceProfile}" -> "${targetProfile}" (${sourceRecord.name}@${target.version})`,
  );
  if (sourceSettings?.hasArgs) {
    console.log(`  args: ${sourceSettings.args}`);
  }
  const envKeys = Object.keys(sourceSettings?.env || {});
  if (envKeys.length) {
    console.log(`  env: ${envKeys.join(', ')}`);
  }
}

function parseRunRawInput() {
  const argv = process.argv.slice(2);
  const runIndex = argv.indexOf('run');
  const args = runIndex >= 0 ? argv.slice(runIndex + 1) : argv;
  const delimiterIndex = args.indexOf('--');
  const beforeDelimiter =
    delimiterIndex >= 0 ? args.slice(0, delimiterIndex) : args;
  const forwardedArgs =
    delimiterIndex >= 0 ? args.slice(delimiterIndex + 1) : null;

  let hasPositionalSelector = false;
  for (let i = 0; i < beforeDelimiter.length; i += 1) {
    const token = beforeDelimiter[i];
    if (token === '--profile' || token === '--agent') {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    hasPositionalSelector = true;
    break;
  }

  return { hasPositionalSelector, forwardedArgs };
}

function formatUsingConfigLine(nearestProjectConfig: AgenvConfig | null) {
  if (nearestProjectConfig?.path) {
    return `> Using project config at ${nearestProjectConfig.path}`;
  }
  return `> Using global config at ${getGlobalConfigFile()}`;
}

function formatUsingProfileLine(profile: string, mode: string | null) {
  if (mode === 'explicit --profile') {
    return `> Using profile "${profile}" (explicit --profile)`;
  }
  if (mode === 'profile selector') {
    return `> Using profile "${profile}" (profile selector)`;
  }
  if (mode === 'tui') {
    return `> Using profile "${profile}" (tui)`;
  }
  return `> Using profile "${profile}"`;
}

function formatUsingDefaultLine(resolved: ResolvedProfile) {
  if (resolved.source === 'project.defaultProfile') {
    return `> Using default profile "${resolved.profile}" (project defaultProfile)`;
  }
  if (resolved.source === 'global.defaultProfile') {
    return `> Using global default profile "${resolved.profile}"`;
  }
  if (resolved.source === 'single.profile') {
    return `> Using only installed profile "${resolved.profile}"`;
  }
  return `> Using profile "${resolved.profile}"`;
}

function formatUsingAgentLine(agent: string | null, resolved: ResolvedProfile) {
  if (resolved.source === `project.agentDefaults.${agent}`) {
    return `> Using ${agent} profile "${resolved.profile}" (project agentDefaults.${agent})`;
  }
  if (resolved.source === `global.agentDefaults.${agent}`) {
    return `> Using ${agent} profile "${resolved.profile}" (global agentDefaults.${agent})`;
  }
  if (resolved.source === 'project.defaultProfile') {
    return `> Using ${agent} profile "${resolved.profile}" (project defaultProfile)`;
  }
  if (resolved.source === 'global.defaultProfile') {
    return `> Using ${agent} profile "${resolved.profile}" (global defaultProfile)`;
  }
  if (resolved.source === 'single.agent-profile') {
    return `> Using only installed ${agent} profile "${resolved.profile}"`;
  }
  return `> Using ${agent} profile "${resolved.profile}"`;
}

interface RunSelection {
  kind: string | null;
  mode: string | null;
  agent: string | null;
}

function describeRunDecision(
  selection: RunSelection | null,
  resolved: ResolvedProfile | null,
) {
  if (!selection || !resolved) return 'unknown';

  if (selection.kind === 'profile') {
    if (selection.mode === 'explicit --profile')
      return 'explicit --profile option';
    if (selection.mode === 'profile selector')
      return 'positional profile selector';
    return 'explicit profile selection';
  }

  if (selection.kind === 'default') {
    if (resolved.source === 'project.defaultProfile') {
      return `project defaultProfile = "${resolved.profile}"`;
    }
    if (resolved.source === 'global.defaultProfile') {
      return `global defaultProfile = "${resolved.profile}"`;
    }
    if (resolved.source === 'single.profile') {
      return 'only one profile is installed';
    }
    return `source = ${resolved.source || 'unknown'}`;
  }

  if (selection.kind === 'agent') {
    const agent = selection.agent || 'unknown';
    if (resolved.source === `project.agentDefaults.${agent}`) {
      return `project agentDefaults.${agent} = "${resolved.profile}"`;
    }
    if (resolved.source === `global.agentDefaults.${agent}`) {
      return `global agentDefaults.${agent} = "${resolved.profile}"`;
    }
    if (
      resolved.source === 'project.defaultProfile' ||
      resolved.source === 'global.defaultProfile'
    ) {
      return `defaultProfile = "${resolved.profile}" (matches agent "${agent}")`;
    }
    if (resolved.source === 'single.agent-profile') {
      return `only one ${agent} profile is installed`;
    }
    return `source = ${resolved.source || 'unknown'}`;
  }

  return `source = ${resolved.source || 'unknown'}`;
}

async function runAction(
  selectorArg: string,
  profileArgs: string[],
  options: {
    profile?: string;
    agent?: string;
    tui?: boolean;
    debug?: boolean;
    dryRun?: boolean;
    yolo?: boolean;
    updateCheck?: boolean;
    env?: string[];
  } = {},
) {
  const profiles = await readInstalledProfiles();
  const { config, nearestProjectConfig } = await loadResolvedConfig(
    process.cwd(),
    profiles,
  );
  const projectConfigPath = nearestProjectConfig.path || null;

  const selector = normalizeProfileName(selectorArg);
  const explicitProfile = normalizeProfileName(options.profile);
  const explicitAgent = normalizeAgentName(options.agent);
  const rawInput = parseRunRawInput();
  const hasSelector = rawInput.hasPositionalSelector;
  const hasExplicitProfile = Boolean(explicitProfile);
  const hasExplicitAgent = Boolean(explicitAgent);

  if (hasExplicitProfile && hasExplicitAgent) {
    throw createUserError(
      `Cannot use --profile and --agent together. Use one:
  agenv run --profile <profile>       # run a specific profile
  agenv run --agent <agent>           # resolve by agent default`,
      { seeCommand: 'run' },
    );
  }
  if (hasSelector && (hasExplicitProfile || hasExplicitAgent)) {
    throw createUserError(
      `Cannot combine positional selector with --profile/--agent. Use one:
  agenv run <selector>                # positional (profile or agent name)
  agenv run --profile <profile>       # explicit profile
  agenv run --agent <agent>           # explicit agent`,
      { seeCommand: 'run' },
    );
  }

  if (options.debug) {
    process.env.AGENV_DEBUG = '1';
  }
  const debugEnabled = Boolean(process.env.AGENV_DEBUG);
  const selection: RunSelection = {
    kind: null,
    mode: null,
    agent: null,
  };

  let resolved: ResolvedProfile | null = null;
  let isTuiSelection = false;

  if (options.tui) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw createUserError(
        `TUI requires an interactive terminal (TTY).
In non-interactive environments, specify the profile directly:
  agenv run <profile>
  agenv run --profile <profile>`,
        { seeCommand: 'run' },
      );
    }

    const result = await runTuiApp();
    if (result.action !== 'run') return;

    selection.kind = 'profile';
    selection.mode = 'tui';
    resolved = { profile: result.profile, source: 'tui' };
    isTuiSelection = true;
  } else if (hasExplicitProfile) {
    assertValidProfileName(explicitProfile);
    selection.kind = 'profile';
    selection.mode = 'explicit --profile';
    resolved = resolveProfileNameDetailed(explicitProfile, {
      config,
      profiles,
      seeCommand: 'run',
    });
  } else if (hasExplicitAgent) {
    assertSupportedAgent(explicitAgent);
    selection.kind = 'agent';
    selection.mode = 'explicit --agent';
    selection.agent = explicitAgent;
    resolved = resolveProfileForAgentDetailed(explicitAgent, {
      config,
      profiles,
      seeCommand: 'run',
      strictProjectSelectors: true,
      projectConfigPath,
    });
  } else if (!selector) {
    selection.kind = 'default';
    selection.mode = 'default';
    resolved = resolveProfileNameDetailed(null, {
      config,
      profiles,
      seeCommand: 'run',
      strictProjectSelectors: true,
      projectConfigPath,
    });
  } else if (SUPPORTED_AGENTS.has(selector)) {
    selection.kind = 'agent';
    selection.mode = 'agent selector';
    selection.agent = selector;
    resolved = resolveProfileForAgentDetailed(selector, {
      config,
      profiles,
      seeCommand: 'run',
      strictProjectSelectors: true,
      projectConfigPath,
    });
  } else {
    selection.kind = 'profile';
    selection.mode = 'profile selector';
    resolved = resolveProfileNameDetailed(selector, {
      config,
      profiles,
      seeCommand: 'run',
    });
  }

  const profile = resolved.profile;

  console.log(formatUsingConfigLine(nearestProjectConfig));
  if (selection.kind === 'agent') {
    console.log(formatUsingAgentLine(selection.agent, resolved));
  } else if (selection.kind === 'default') {
    console.log(formatUsingDefaultLine(resolved));
  } else {
    console.log(formatUsingProfileLine(profile, selection.mode));
  }

  const record = resolveProfileRecord(profile, profiles, {
    seeCommand: 'run',
  });
  const binPath = await findAgentBinary(record.agentPath, record.package);
  if (!binPath) {
    throw createUserError(
      `Unable to find executable for package "${record.package}".
The installation may be corrupted. Try reinstalling:
  agenv install ${record.name} ${profile} --force`,
      { seeCommand: 'install' },
    );
  }

  const settings = getResolvedProfileSettings(config, profile);
  const runtimeArgs =
    (hasExplicitProfile || hasExplicitAgent || isTuiSelection) &&
    rawInput.forwardedArgs
      ? rawInput.forwardedArgs
      : profileArgs || [];
  const savedArgs = parseArgsString(settings.args);
  const yoloArgs = options.yolo ? getYoloArgs(record.name) : [];
  if (options.yolo) {
    console.log(`Yolo mode: adding "${yoloArgs.join(' ')}" for this run.`);
  }
  const combinedArgs = [...savedArgs, ...yoloArgs, ...runtimeArgs];

  const runtimeEnv = parseEnvPairs(options.env);
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...settings.env,
    ...runtimeEnv,
  };

  const envVar = envVarForAgent(record.name);
  if (envVar) {
    env[envVar] = record.configPath;
  }
  env.AGENV_PROFILE = profile;

  if (debugEnabled) {
    const projectPath = nearestProjectConfig?.path || null;
    const globalConfig = await loadGlobalConfig();
    const forwarded = rawInput.forwardedArgs || null;
    const mergedProfileConfig = config.profiles?.[profile] || null;
    const projectProfileConfig = projectPath
      ? nearestProjectConfig.profiles?.[profile] || null
      : null;
    const globalProfileConfig = globalConfig.profiles?.[profile] || null;

    const envKeysEffective = Object.keys(settings.env).sort();
    const envKeysFromProject = projectProfileConfig
      ? envKeysEffective.filter((key) =>
          Object.prototype.hasOwnProperty.call(
            projectProfileConfig.env || {},
            key,
          ),
        )
      : [];
    const envKeysFromGlobal = envKeysEffective.filter(
      (key) => !envKeysFromProject.includes(key),
    );

    console.log('debug: selector');
    console.log(`debug:   kind = ${selection.kind || 'unknown'}`);
    if (selection.agent) {
      console.log(`debug:   agent = ${selection.agent}`);
    }
    console.log(`debug:   mode = ${selection.mode || 'unknown'}`);
    console.log(`debug:   source = ${resolved.source || 'unknown'}`);

    console.log('debug: config');
    console.log(`debug:   project = ${projectPath || '(not found)'}`);
    console.log(`debug:   global  = ${getGlobalConfigFile()}`);

    console.log('debug: config values');
    console.log(
      `debug:   project.defaultProfile = ${nearestProjectConfig.defaultProfile ? `"${nearestProjectConfig.defaultProfile}"` : '(unset)'}`,
    );
    console.log(
      `debug:   global.defaultProfile = ${globalConfig.defaultProfile ? `"${globalConfig.defaultProfile}"` : '(unset)'}`,
    );
    if (selection.kind === 'agent' && selection.agent) {
      console.log(
        `debug:   project.agentDefaults.${selection.agent} = ${nearestProjectConfig.agentDefaults?.[selection.agent] ? `"${nearestProjectConfig.agentDefaults[selection.agent]}"` : '(unset)'}`,
      );
      console.log(
        `debug:   global.agentDefaults.${selection.agent} = ${globalConfig.agentDefaults?.[selection.agent] ? `"${globalConfig.agentDefaults[selection.agent]}"` : '(unset)'}`,
      );
    }

    console.log('debug: effective');
    console.log(
      `debug:   defaultProfile = ${config.defaultProfile ? `"${config.defaultProfile}"` : '(unset)'} (${config.sources.defaultProfile || 'unset'})`,
    );
    if (selection.kind === 'agent' && selection.agent) {
      const agentDefault = config.agentDefaults?.[selection.agent] || null;
      const agentSource =
        config.sources.agentDefaults?.[selection.agent] || 'unset';
      console.log(
        `debug:   agentDefaults.${selection.agent} = ${agentDefault ? `"${agentDefault}"` : '(unset)'} (${agentSource})`,
      );
    }

    console.log('debug: decision');
    console.log(`debug:   chose profile "${profile}"`);
    console.log(
      `debug:   reason = ${describeRunDecision(selection, resolved)}`,
    );

    console.log('debug: profile settings (effective)');
    console.log(
      `debug:   args = ${mergedProfileConfig?.hasArgs ? `"${mergedProfileConfig.args}"` : '(unset)'}`,
    );
    console.log(
      `debug:   env set = ${envKeysEffective.length ? `[${envKeysEffective.join(', ')}]` : '[]'}`,
    );
    console.log(
      `debug:   env source project = ${envKeysFromProject.length ? `[${envKeysFromProject.sort().join(', ')}]` : '[]'}`,
    );
    console.log(
      `debug:   env source global = ${envKeysFromGlobal.length ? `[${envKeysFromGlobal.sort().join(', ')}]` : '[]'}`,
    );

    console.log('debug: profile settings (project)');
    if (projectPath && projectProfileConfig) {
      console.log(
        `debug:   args = ${projectProfileConfig.hasArgs ? `"${projectProfileConfig.args}"` : '(unset)'}`,
      );
      console.log(
        `debug:   env keys = ${
          Object.keys(projectProfileConfig.env || {}).length
            ? `[${Object.keys(projectProfileConfig.env || {})
                .sort()
                .join(', ')}]`
            : '[]'
        }`,
      );
    } else if (projectPath) {
      console.log('debug:   (no profile entry)');
    } else {
      console.log('debug:   (no project config)');
    }

    console.log('debug: profile settings (global)');
    if (globalProfileConfig) {
      console.log(
        `debug:   args = ${globalProfileConfig.hasArgs ? `"${globalProfileConfig.args}"` : '(unset)'}`,
      );
      console.log(
        `debug:   env keys = ${
          Object.keys(globalProfileConfig.env || {}).length
            ? `[${Object.keys(globalProfileConfig.env || {})
                .sort()
                .join(', ')}]`
            : '[]'
        }`,
      );
    } else {
      console.log('debug:   (no profile entry)');
    }

    console.log('debug: runtime');
    console.log(`debug:   package = ${record.package}@${record.version}`);
    console.log(`debug:   bin = ${binPath}`);
    if (envVar) {
      console.log(`debug:   set ${envVar} = ${record.configPath}`);
    }

    console.log('debug: argv');
    console.log(
      `debug:   saved = ${savedArgs.length ? JSON.stringify(savedArgs) : '[]'}`,
    );
    console.log(
      `debug:   runtime = ${runtimeArgs.length ? JSON.stringify(runtimeArgs) : '[]'}`,
    );
    console.log(
      `debug:   raw_delimited = ${forwarded ? JSON.stringify(forwarded) : '[]'}`,
    );
    console.log(
      `debug:   final = ${combinedArgs.length ? JSON.stringify(combinedArgs) : '[]'}`,
    );
  }

  if (options.dryRun) {
    console.log(`Profile:  ${profile}`);
    console.log(`Agent:    ${record.name}@${record.version}`);
    console.log(`Binary:   ${binPath}`);
    console.log(
      `Args:     ${combinedArgs.length ? combinedArgs.join(' ') : '(none)'}`,
    );
    if (savedArgs.length) {
      console.log(`  saved:  ${savedArgs.join(' ')}`);
    }
    if (runtimeArgs.length) {
      console.log(`  runtime: ${runtimeArgs.join(' ')}`);
    }
    if (envVar) {
      console.log(`Env:      ${envVar}=${record.configPath}`);
    }
    const profileEnvKeys = Object.keys(settings.env);
    if (profileEnvKeys.length) {
      console.log(`Env set:  ${profileEnvKeys.join(', ')}`);
    }
    const runtimeEnvKeys = Object.keys(runtimeEnv);
    if (runtimeEnvKeys.length) {
      console.log(`Env --env: ${runtimeEnvKeys.join(', ')}`);
    }
    return;
  }

  const skipUpdateCheck =
    options.updateCheck === false || Boolean(process.env.AGENV_NO_UPDATE_CHECK);
  if (!skipUpdateCheck) {
    try {
      const [installedVer, latestVer] = await Promise.all([
        readInstalledVersion(record.agentPath, record.package),
        fetchLatestVersion(record.package),
      ]);
      if (
        installedVer &&
        latestVer &&
        isNewerVersion(latestVer, installedVer)
      ) {
        if (record.pinned) {
          console.error(
            `Note: ${record.name} ${latestVer} is available (pinned to ${installedVer}). Run \`agenv update ${profile}\` to unpin and update.`,
          );
        } else {
          const wantsUpdate = await askUserToUpdate(
            profile,
            record.name,
            installedVer,
            latestVer,
          );
          if (wantsUpdate) {
            await ensureInstalled(
              { ...record, version: 'latest', pinned: false },
              { force: true },
            );
            console.log(
              `> Updated ${record.name} to ${latestVer} for profile "${profile}"`,
            );
          }
        }
      }
    } catch (err: unknown) {
      if (process.env.AGENV_DEBUG) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: update check failed: ${message}`);
      }
    }
  }

  console.log(
    `> Running profile "${profile}" (${record.name}@${record.version}) from ${record.agentPath}${combinedArgs.length ? ` with args: ${combinedArgs.join(' ')}` : ''}`,
  );
  await runCommand(binPath, combinedArgs, { stdio: 'inherit', env });
}

function wrapAction<T extends (...args: never[]) => Promise<void>>(
  fn: T,
): (...args: Parameters<T>) => Promise<void> {
  return async (...args: Parameters<T>) => {
    await maybeNotifySelfUpdate();
    await fn(...args);
  };
}

export {
  installAction,
  updateAction,
  removeAction,
  editAction,
  defaultAction,
  listAction,
  showAction,
  cloneAction,
  runAction,
  wrapAction,
};
