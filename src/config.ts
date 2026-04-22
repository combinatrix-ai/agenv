import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ErrorObject, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import { getGlobalConfigFile, pathExists, readJson, writeJson } from './state';
import {
  SUPPORTED_AGENTS,
  assertSupportedAgent,
  normalizeAgentName,
  normalizeProfileName,
  stringifyArgs,
} from './agents';
import { CliUserError, createUserError, isENOENT } from './errors';
import type {
  ProfileConfig,
  AgenvConfig,
  ProfileRecord,
  UpdateProfileOptions,
  UpdateProfileResult,
} from './types';

const CONFIG_FILENAME = '.agenv.json';
const CONFIG_SCHEMA_PATH = path.resolve(__dirname, '..', '.agenv.schema.json');
const CONFIG_SCHEMA = JSON.parse(
  fsSync.readFileSync(CONFIG_SCHEMA_PATH, 'utf8'),
) as object;
const CONFIG_SCHEMA_VALIDATOR: ValidateFunction = new Ajv2020({
  allErrors: true,
  strict: false,
}).compile(CONFIG_SCHEMA);

function describeSchemaPath(instancePath: string): string {
  if (!instancePath) return 'config';
  return `config${instancePath.replace(/\//g, '.')}`;
}

function formatSchemaError(error: ErrorObject): string {
  const location = describeSchemaPath(error.instancePath);

  switch (error.keyword) {
    case 'additionalProperties': {
      const additionalProperty = String(
        (error.params as { additionalProperty?: string }).additionalProperty ||
          '(unknown)',
      );
      return `${location}: unknown property "${additionalProperty}"`;
    }
    case 'required': {
      const missingProperty = String(
        (error.params as { missingProperty?: string }).missingProperty ||
          '(unknown)',
      );
      return `${location}: missing required property "${missingProperty}"`;
    }
    case 'type': {
      const expectedType = String(
        (error.params as { type?: string }).type || 'the expected type',
      );
      return `${location}: must be ${expectedType}`;
    }
    case 'pattern': {
      const pattern = String(
        (error.params as { pattern?: string }).pattern || '(unknown)',
      );
      return `${location}: must match pattern ${pattern}`;
    }
    default:
      return `${location}: ${error.message || error.keyword}`;
  }
}

function validateConfigSchema(configPath: string, parsed: unknown) {
  const valid = CONFIG_SCHEMA_VALIDATOR(parsed);
  if (valid) return;

  const errors = (CONFIG_SCHEMA_VALIDATOR.errors || []).map(formatSchemaError);
  throw createUserError(
    `Invalid config file ${configPath}:\n- ${errors.join('\n- ')}`,
  );
}

function createProfileConfig(): ProfileConfig {
  return {
    hasArgs: false,
    args: '',
    env: {},
  };
}

function emptyConfig(configPath: string | null = null): AgenvConfig {
  return {
    defaultProfile: null,
    agentDefaults: {},
    profiles: {},
    path: configPath,
    sources: {
      defaultProfile: null,
      agentDefaults: {},
    },
  };
}

function mergeConfigs(configs: AgenvConfig[]): AgenvConfig {
  const merged = emptyConfig(configs[0]?.path || null);
  const orderedConfigs = [...configs].reverse();

  for (const config of orderedConfigs) {
    const isGlobalConfig = config.path === getGlobalConfigFile();
    const defaultSource = isGlobalConfig
      ? 'global.defaultProfile'
      : 'project.defaultProfile';

    if (config.defaultProfile) {
      merged.defaultProfile = config.defaultProfile;
      merged.sources.defaultProfile = defaultSource;
    }

    for (const [agent, profile] of Object.entries(config.agentDefaults || {})) {
      merged.agentDefaults[agent] = profile;
      merged.sources.agentDefaults[agent] = isGlobalConfig
        ? `global.agentDefaults.${agent}`
        : `project.agentDefaults.${agent}`;
    }

    for (const [profileName, profileConfig] of Object.entries(
      config.profiles || {},
    )) {
      if (!merged.profiles[profileName]) {
        merged.profiles[profileName] = createProfileConfig();
      }
      const mergedProfile = merged.profiles[profileName];

      if (profileConfig.hasArgs) {
        mergedProfile.args = profileConfig.args;
        mergedProfile.hasArgs = true;
      }

      for (const [key, value] of Object.entries(profileConfig.env || {})) {
        mergedProfile.env[key] = value;
      }
    }
  }

  return merged;
}

function parseEnvPairs(
  input: string[] | string | null | undefined,
): Record<string, string> {
  if (!input) return {};
  const items = Array.isArray(input) ? input : [input];
  const env: Record<string, string> = {};
  for (const item of items) {
    const pair = String(item || '').trim();
    if (!pair) continue;
    const index = pair.indexOf('=');
    if (index <= 0) {
      throw createUserError(
        `Invalid --env value "${pair}". Use KEY=VALUE format.`,
      );
    }
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw createUserError(`Invalid environment variable name "${key}".`);
    }
    env[key] = value;
  }
  return env;
}

function ensureProfileConfig(
  config: AgenvConfig,
  profile: string,
): ProfileConfig {
  if (!config.profiles[profile]) {
    config.profiles[profile] = createProfileConfig();
  }
  return config.profiles[profile];
}

function updateProfileConfig(
  config: AgenvConfig,
  profile: string,
  options: UpdateProfileOptions = {},
): UpdateProfileResult {
  const profileConfig = ensureProfileConfig(config, profile);
  let changed = false;
  const { savedArgs, clearArgs, envInput, setDefault, agent } = options;

  if (clearArgs) {
    if (profileConfig.hasArgs || profileConfig.args) {
      profileConfig.hasArgs = false;
      profileConfig.args = '';
      changed = true;
    }
  } else {
    const savedArgsString = stringifyArgs(savedArgs);
    if (savedArgsString) {
      profileConfig.args = savedArgsString;
      profileConfig.hasArgs = true;
      changed = true;
    }
  }

  const envOverrides = parseEnvPairs(envInput);
  for (const [key, value] of Object.entries(envOverrides)) {
    if (profileConfig.env[key] !== value) {
      profileConfig.env[key] = value;
      changed = true;
    }
  }

  if (setDefault && config.defaultProfile !== profile) {
    config.defaultProfile = profile;
    changed = true;
  }

  if (agent) {
    const normalizedAgent = normalizeAgentName(agent);
    assertSupportedAgent(normalizedAgent);
    if (config.agentDefaults[normalizedAgent] !== profile) {
      config.agentDefaults[normalizedAgent] = profile;
      changed = true;
    }
  }

  return {
    changed,
    savedArgsApplied: !clearArgs && Boolean(stringifyArgs(savedArgs)),
    envKeys: Object.keys(envOverrides),
  };
}

function normalizeConfigObject(
  parsed: unknown,
  configPath: string | null,
): AgenvConfig {
  const config = emptyConfig(configPath);

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.defaultProfile === 'string') {
    config.defaultProfile = normalizeProfileName(obj.defaultProfile);
  }

  if (obj.agentDefaults && typeof obj.agentDefaults === 'object') {
    for (const [agentName, profileName] of Object.entries(
      obj.agentDefaults as Record<string, unknown>,
    )) {
      const agent = normalizeAgentName(agentName);
      config.agentDefaults[agent] = normalizeProfileName(profileName as string);
    }
  }

  if (obj.profiles && typeof obj.profiles === 'object') {
    for (const [name, value] of Object.entries(
      obj.profiles as Record<string, unknown>,
    )) {
      const profile = normalizeProfileName(name);
      const next = createProfileConfig();
      const profileValue = value as Record<string, unknown>;

      if (Object.prototype.hasOwnProperty.call(value, 'args')) {
        next.args = profileValue.args as string;
        next.hasArgs = true;
      }

      if (Object.prototype.hasOwnProperty.call(value, 'env')) {
        next.env = {
          ...((profileValue.env as Record<string, string> | undefined) || {}),
        };
      }

      config.profiles[profile] = next;
    }
  }

  return config;
}

async function loadConfigFile(configPath: string): Promise<AgenvConfig> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    validateConfigSchema(configPath, parsed);
    return normalizeConfigObject(parsed, configPath);
  } catch (err: unknown) {
    if (isENOENT(err)) {
      return emptyConfig(configPath);
    }
    if (err instanceof CliUserError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw createUserError(`Failed to parse ${configPath}: ${message}`);
  }
}

async function findNearestConfigFile(
  startDir = process.cwd(),
): Promise<string | null> {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function loadGlobalConfig(): Promise<AgenvConfig> {
  if (!(await pathExists(getGlobalConfigFile()))) {
    return emptyConfig(getGlobalConfigFile());
  }
  return loadConfigFile(getGlobalConfigFile());
}

function parseInstalledAt(value: string | undefined): number {
  const time = Date.parse(String(value || ''));
  if (Number.isNaN(time)) return Number.MAX_SAFE_INTEGER;
  return time;
}

function pickOldestInstalledProfile(
  profiles: Record<string, ProfileRecord>,
  agent: string | null = null,
): string | null {
  const candidates = Object.values(profiles).filter(
    (record) => !agent || record.name === agent,
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const diff =
      parseInstalledAt(a.installedAt) - parseInstalledAt(b.installedAt);
    if (diff !== 0) return diff;
    return a.profile.localeCompare(b.profile);
  });
  return candidates[0].profile;
}

function healGlobalDefaults(
  globalConfig: AgenvConfig,
  profiles: Record<string, ProfileRecord>,
) {
  let changed = false;

  const profileNames = Object.keys(profiles);
  if (!profileNames.length) {
    if (globalConfig.defaultProfile) {
      globalConfig.defaultProfile = null;
      changed = true;
    }
    if (Object.keys(globalConfig.agentDefaults || {}).length) {
      globalConfig.agentDefaults = {};
      changed = true;
    }
    return { changed };
  }

  const oldestProfile = pickOldestInstalledProfile(profiles);
  if (!globalConfig.defaultProfile || !profiles[globalConfig.defaultProfile]) {
    if (globalConfig.defaultProfile !== oldestProfile) {
      globalConfig.defaultProfile = oldestProfile;
      changed = true;
    }
  }

  for (const agent of Array.from(SUPPORTED_AGENTS)) {
    const configuredProfile = globalConfig.agentDefaults?.[agent];
    const isValid =
      configuredProfile &&
      profiles[configuredProfile] &&
      profiles[configuredProfile].name === agent;
    const oldestForAgent = pickOldestInstalledProfile(profiles, agent);

    if (!oldestForAgent) {
      if (configuredProfile) {
        delete globalConfig.agentDefaults[agent];
        changed = true;
      }
      continue;
    }

    if (!isValid) {
      globalConfig.agentDefaults[agent] = oldestForAgent;
      changed = true;
    }
  }

  return { changed };
}

async function loadResolvedConfig(
  cwd = process.cwd(),
  profiles: Record<string, ProfileRecord> | null = null,
) {
  const configs: AgenvConfig[] = [];
  const projectFile = await findNearestConfigFile(cwd);
  const projectConfig = projectFile
    ? await loadConfigFile(projectFile)
    : emptyConfig();
  configs.push(projectConfig);

  const globalConfig = await loadGlobalConfig();
  if (profiles) {
    const healed = healGlobalDefaults(globalConfig, profiles);
    if (healed.changed) {
      await writeConfigFile(globalConfig, getGlobalConfigFile());
    }
  }
  configs.push(globalConfig);

  return {
    config: mergeConfigs(configs),
    nearestProjectConfig: projectConfig,
  };
}

function serializeConfig(config: AgenvConfig) {
  const data: Record<string, unknown> = {};
  if (config.defaultProfile) {
    data.defaultProfile = config.defaultProfile;
  }
  if (Object.keys(config.agentDefaults || {}).length) {
    data.agentDefaults = config.agentDefaults;
  }

  const profiles: Record<string, Record<string, unknown>> = {};
  for (const [profileName, profileConfig] of Object.entries(
    config.profiles || {},
  )) {
    const next: Record<string, unknown> = {};
    if (profileConfig.hasArgs) {
      next.args = profileConfig.args;
    }
    if (Object.keys(profileConfig.env || {}).length) {
      next.env = profileConfig.env;
    }
    if (Object.keys(next).length) {
      profiles[profileName] = next;
    }
  }

  if (Object.keys(profiles).length) {
    data.profiles = profiles;
  }

  return data;
}

async function writeConfigFile(config: AgenvConfig, targetPath: string) {
  await writeJson(targetPath, serializeConfig(config));
}

function localConfigPath(cwd = process.cwd()) {
  return path.join(cwd, CONFIG_FILENAME);
}

async function loadOrCreateLocalConfig(
  targetPath = localConfigPath(),
): Promise<AgenvConfig> {
  if (await pathExists(targetPath)) {
    return loadConfigFile(targetPath);
  }
  return emptyConfig(targetPath);
}

export {
  loadGlobalConfig,
  loadResolvedConfig,
  writeConfigFile,
  localConfigPath,
  loadOrCreateLocalConfig,
  healGlobalDefaults,
  updateProfileConfig,
  parseEnvPairs,
};
