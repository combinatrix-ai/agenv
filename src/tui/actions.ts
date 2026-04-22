import fs from 'node:fs/promises';
import { profilePaths } from '../install';
import {
  loadGlobalConfig,
  writeConfigFile,
  healGlobalDefaults,
  updateProfileConfig,
  loadResolvedConfig,
  loadOrCreateLocalConfig,
  localConfigPath,
} from '../config';
import { getGlobalConfigFile } from '../state';
import { readInstalledProfiles } from '../resolution';
import { parseArgsString } from '../agents';
import type { AgenvConfig, ProfileRecord } from '../types';

export type EditScope = 'global' | 'project';

export interface TuiState {
  profiles: Record<string, ProfileRecord>;
  config: AgenvConfig;
  projectConfig: AgenvConfig;
  globalConfig: AgenvConfig;
}

export async function loadTuiState(): Promise<TuiState> {
  const profiles = await readInstalledProfiles();
  const { config, nearestProjectConfig } = await loadResolvedConfig(
    process.cwd(),
    profiles,
  );
  const globalConfig = await loadGlobalConfig();
  return {
    profiles,
    config,
    projectConfig: nearestProjectConfig,
    globalConfig,
  };
}

export interface ScopeView {
  hasArgs: boolean;
  args: string;
  argsArray: string[];
  envKeys: string[];
  env: Record<string, string>;
}

export interface ProfileView {
  profile: string;
  record: ProfileRecord;
  hasProjectEntry: boolean;
  global: ScopeView;
  project: ScopeView;
  effective: ScopeView;
  defaults: string[];
  shadowedDefaults: string[];
  projectDefaults: string[];
  globalDefaults: string[];
}

function scopeFromConfig(config: AgenvConfig, profile: string): ScopeView {
  const p = config.profiles?.[profile];
  const env = { ...(p?.env || {}) };
  const args = p?.args || '';
  return {
    hasArgs: Boolean(p?.hasArgs),
    args,
    argsArray: args ? parseArgsString(args) : [],
    envKeys: Object.keys(env).sort(),
    env,
  };
}

function defaultsOfScope(config: AgenvConfig, profile: string): string[] {
  const out: string[] = [];
  for (const [agent, value] of Object.entries(config.agentDefaults || {})) {
    if (value === profile) out.push(agent);
  }
  out.sort();
  if (config.defaultProfile === profile) out.push('default');
  return out;
}

function hasAnyProjectEntry(config: AgenvConfig, profile: string): boolean {
  if (config.profiles?.[profile]) return true;
  if (config.defaultProfile === profile) return true;
  for (const value of Object.values(config.agentDefaults || {})) {
    if (value === profile) return true;
  }
  return false;
}

export function buildProfileViews(state: TuiState): ProfileView[] {
  const sorted = Object.values(state.profiles).sort((a, b) =>
    a.profile.localeCompare(b.profile),
  );

  return sorted.map((record) => {
    const profile = record.profile;
    const global = scopeFromConfig(state.globalConfig, profile);
    const project = scopeFromConfig(state.projectConfig, profile);
    const effective = scopeFromConfig(state.config, profile);
    const hasProjectEntry = hasAnyProjectEntry(state.projectConfig, profile);

    const defaults = defaultsOfScope(state.config, profile);
    const projectDefaults = defaultsOfScope(state.projectConfig, profile);
    const globalDefaults = defaultsOfScope(state.globalConfig, profile);
    const shadowedDefaults = globalDefaults.filter((name) => {
      if (name === 'default')
        return state.projectConfig.defaultProfile !== null;
      return state.projectConfig.agentDefaults?.[name] !== undefined;
    });

    return {
      profile,
      record,
      hasProjectEntry,
      global,
      project,
      effective,
      defaults,
      shadowedDefaults,
      projectDefaults,
      globalDefaults,
    };
  });
}

async function setAsGlobalDefault(profile: string): Promise<void> {
  const config = await loadGlobalConfig();
  const update = updateProfileConfig(config, profile, { setDefault: true });
  if (update.changed) {
    await writeConfigFile(config, getGlobalConfigFile());
  }
}

async function setAsProjectDefault(profile: string): Promise<void> {
  const targetPath = localConfigPath();
  const config = await loadOrCreateLocalConfig(targetPath);
  const update = updateProfileConfig(config, profile, { setDefault: true });
  if (update.changed) {
    await writeConfigFile(config, targetPath);
  }
}

async function setAsGlobalAgentDefault(
  profile: string,
  agent: string,
): Promise<void> {
  const config = await loadGlobalConfig();
  const update = updateProfileConfig(config, profile, { agent });
  if (update.changed) {
    await writeConfigFile(config, getGlobalConfigFile());
  }
}

async function setAsProjectAgentDefault(
  profile: string,
  agent: string,
): Promise<void> {
  const targetPath = localConfigPath();
  const config = await loadOrCreateLocalConfig(targetPath);
  const update = updateProfileConfig(config, profile, { agent });
  if (update.changed) {
    await writeConfigFile(config, targetPath);
  }
}

async function loadScope(scope: EditScope): Promise<{
  config: AgenvConfig;
  target: string;
}> {
  if (scope === 'global') {
    return { config: await loadGlobalConfig(), target: getGlobalConfigFile() };
  }
  const target = localConfigPath();
  return { config: await loadOrCreateLocalConfig(target), target };
}

export async function setProfileArgsArray(
  profile: string,
  scope: EditScope,
  args: string[],
): Promise<void> {
  const { config, target } = await loadScope(scope);
  const update =
    args.length === 0
      ? updateProfileConfig(config, profile, { clearArgs: true })
      : updateProfileConfig(config, profile, { savedArgs: args });
  if (update.changed) {
    await writeConfigFile(config, target);
  }
}

export async function setProfileEnv(
  profile: string,
  scope: EditScope,
  kv: string,
  replaceKey?: string,
): Promise<void> {
  const { config, target } = await loadScope(scope);
  if (replaceKey) {
    const profileConfig = config.profiles?.[profile];
    if (profileConfig?.env && replaceKey in profileConfig.env) {
      delete profileConfig.env[replaceKey];
    }
  }
  const update = updateProfileConfig(config, profile, { envInput: [kv] });
  if (update.changed || replaceKey) {
    await writeConfigFile(config, target);
  }
}

export async function claimProfileDefault(
  profile: string,
  scope: EditScope,
  name: string,
): Promise<void> {
  if (name === 'default') {
    if (scope === 'global') {
      await setAsGlobalDefault(profile);
    } else {
      await setAsProjectDefault(profile);
    }
    return;
  }
  if (scope === 'global') {
    await setAsGlobalAgentDefault(profile, name);
  } else {
    await setAsProjectAgentDefault(profile, name);
  }
}

export async function removeProfileEnv(
  profile: string,
  scope: EditScope,
  key: string,
): Promise<void> {
  const { config, target } = await loadScope(scope);
  const profileConfig = config.profiles?.[profile];
  if (!profileConfig?.env || !(key in profileConfig.env)) return;
  delete profileConfig.env[key];
  await writeConfigFile(config, target);
}

export async function removeProfileSilent(profile: string): Promise<void> {
  const { profilePath } = profilePaths(profile);
  await fs.rm(profilePath, { recursive: true, force: true });
  const remaining = await readInstalledProfiles();
  const config = await loadGlobalConfig();
  const healed = healGlobalDefaults(config, remaining);
  if (healed.changed) {
    await writeConfigFile(config, getGlobalConfigFile());
  }
}
