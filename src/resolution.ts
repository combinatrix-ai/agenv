import fs from 'node:fs/promises';
import path from 'node:path';
import { getAgentsDir, pathExists, readJson } from './state';
import { profilePaths } from './install';
import {
  SUPPORTED_AGENTS,
  DEFAULT_PACKAGES,
  normalizeAgentName,
  normalizeProfileName,
  assertValidProfileName,
} from './agents';
import { createUserError, isENOENT } from './errors';
import { suggestProfile } from './suggest';
import type {
  AgenvConfig,
  ProfileRecord,
  ProfileSettings,
  ResolvedProfile,
} from './types';

async function readProfileRecord(
  profile: string,
): Promise<ProfileRecord | null> {
  const defaults = profilePaths(profile);
  const profileMetaPath = path.join(defaults.profilePath, 'profile.json');
  const meta = await readJson(profileMetaPath, null);

  if (!meta || typeof meta !== 'object') return null;

  const metaObj = meta as Record<string, unknown>;
  const name = normalizeAgentName(
    (metaObj.agent || metaObj.name) as string | undefined,
  );
  if (!SUPPORTED_AGENTS.has(name)) return null;

  return {
    profile,
    name,
    package: (metaObj.package as string) || DEFAULT_PACKAGES[name] || name,
    version: (metaObj.version as string) || 'latest',
    pinned: Boolean(metaObj.pinned),
    installedAt:
      typeof metaObj.installedAt === 'string'
        ? metaObj.installedAt
        : new Date().toISOString(),
    profilePath: (metaObj.profilePath as string) || defaults.profilePath,
    agentPath: (metaObj.agentPath as string) || defaults.agentPath,
    configPath: (metaObj.configPath as string) || defaults.configPath,
  };
}

async function readInstalledProfiles(): Promise<Record<string, ProfileRecord>> {
  const profiles: Record<string, ProfileRecord> = {};
  let entries: string[] = [];
  try {
    entries = await fs.readdir(getAgentsDir());
  } catch (err: unknown) {
    if (isENOENT(err)) {
      return profiles;
    }
    throw err;
  }

  for (const name of entries) {
    const fullPath = path.join(getAgentsDir(), name);
    const stat = await fs.stat(fullPath);
    if (!stat.isDirectory()) continue;
    const profile = normalizeProfileName(name);
    if (!profile) continue;
    const record = await readProfileRecord(profile);
    if (record && (await pathExists(record.agentPath))) {
      profiles[profile] = record;
    }
  }

  return profiles;
}

function resolveProfileRecord(
  profile: string,
  profiles: Record<string, ProfileRecord>,
  { seeCommand = 'show' }: { seeCommand?: string } = {},
): ProfileRecord {
  const record = profiles[profile];
  if (!record) {
    const candidates = Object.keys(profiles);
    const suggestion = suggestProfile(profile, candidates);
    const lines = [`Profile "${profile}" is not installed.`];
    if (suggestion) {
      lines.push(`Did you mean "${suggestion}"?`);
    }
    if (candidates.length) {
      lines.push(`Available profiles: ${candidates.join(', ')}`);
    }
    lines.push(`To install: agenv install <agent> ${profile}`);
    throw createUserError(lines.join('\n'), { seeCommand });
  }
  return record;
}

function resolveProfileNameDetailed(
  input: string | null,
  {
    config,
    profiles,
    seeCommand,
    strictProjectSelectors = false,
    projectConfigPath = null,
  }: {
    config: AgenvConfig;
    profiles: Record<string, ProfileRecord>;
    seeCommand?: string;
    strictProjectSelectors?: boolean;
    projectConfigPath?: string | null;
  },
): ResolvedProfile {
  if (input) {
    const profile = normalizeProfileName(input);
    assertValidProfileName(profile);
    if (!profiles[profile]) {
      const candidates = Object.keys(profiles);
      const suggestion = suggestProfile(profile, candidates);
      const lines = [`Profile "${profile}" is not installed.`];
      if (suggestion) {
        lines.push(`Did you mean "${suggestion}"?`);
      }
      if (candidates.length) {
        lines.push(`Available profiles: ${candidates.join(', ')}`);
      } else {
        lines.push(
          'No profiles installed. Run `agenv install <agent>` to get started.',
        );
      }
      throw createUserError(lines.join('\n'), { seeCommand });
    }
    return { profile, source: 'explicit' };
  }

  if (config.defaultProfile) {
    if (profiles[config.defaultProfile]) {
      return {
        profile: config.defaultProfile,
        source: config.sources.defaultProfile || 'global.defaultProfile',
      };
    }
    if (
      strictProjectSelectors &&
      config.sources.defaultProfile === 'project.defaultProfile'
    ) {
      const filePath = projectConfigPath || '.agenv.json';
      throw createUserError(
        `Project config ${filePath} sets defaultProfile to "${config.defaultProfile}", but that profile is not installed.
Fix one of:
  - install it:                 agenv install <agent> ${config.defaultProfile}
  - point at another profile:   agenv default local <other>
  - bypass for this run:        agenv run --profile <other>
  - edit the file directly:     ${filePath}`,
        { seeCommand: seeCommand || 'run' },
      );
    }
  }

  const installedProfiles = Object.keys(profiles);
  if (installedProfiles.length === 1) {
    return { profile: installedProfiles[0], source: 'single.profile' };
  }

  if (!installedProfiles.length) {
    throw createUserError(
      `No profiles installed yet.

  Quick start:
    agenv install codex               # OpenAI Codex
    agenv install claude              # Anthropic Claude Code
    agenv install gemini              # Google Gemini CLI

  Then run with: agenv run`,
      { seeCommand: 'install' },
    );
  }

  throw createUserError(
    `Multiple profiles found: ${installedProfiles.join(', ')}.
Specify which profile to use:
  agenv run <profile>                 # by profile name
  agenv run <agent>                   # by agent (codex|claude|gemini)
  agenv default local <profile>       # set a project default
  agenv default global <profile>      # set a global default`,
    { seeCommand: seeCommand || 'run' },
  );
}

function resolveProfileForAgentDetailed(
  agent: string,
  {
    config,
    profiles,
    seeCommand,
    strictProjectSelectors = false,
    projectConfigPath = null,
  }: {
    config: AgenvConfig;
    profiles: Record<string, ProfileRecord>;
    seeCommand?: string;
    strictProjectSelectors?: boolean;
    projectConfigPath?: string | null;
  },
): ResolvedProfile {
  const localProfile = config.agentDefaults?.[agent];
  if (localProfile) {
    if (profiles[localProfile]?.name === agent) {
      return {
        profile: localProfile,
        source:
          config.sources.agentDefaults[agent] ||
          `global.agentDefaults.${agent}`,
      };
    }
    if (
      strictProjectSelectors &&
      config.sources.agentDefaults[agent] === `project.agentDefaults.${agent}`
    ) {
      const filePath = projectConfigPath || '.agenv.json';
      const record = profiles[localProfile];
      const reason = !record
        ? 'that profile is not installed'
        : `that profile is installed for agent "${record.name}", not "${agent}"`;
      throw createUserError(
        `Project config ${filePath} sets agentDefaults.${agent} to "${localProfile}", but ${reason}.
Fix one of:
  - install it:                              agenv install ${agent} ${localProfile}
  - point at another ${agent} profile:       agenv default local <other> --for ${agent}
  - bypass for this run:                     agenv run --profile <other>
  - edit the file directly:                  ${filePath}`,
        { seeCommand: seeCommand || 'run' },
      );
    }
  }

  if (
    config.defaultProfile &&
    profiles[config.defaultProfile]?.name === agent
  ) {
    return {
      profile: config.defaultProfile,
      source: config.sources.defaultProfile || 'global.defaultProfile',
    };
  }

  const candidates = Object.values(profiles)
    .filter((profile) => profile.name === agent)
    .map((profile) => profile.profile);

  if (candidates.length === 1) {
    return { profile: candidates[0], source: 'single.agent-profile' };
  }
  if (!candidates.length) {
    throw createUserError(
      `No installed profile for agent "${agent}".

  Install one:
    agenv install ${agent}
    agenv install ${agent} my-${agent}             # custom profile name`,
      { seeCommand: seeCommand || 'run' },
    );
  }

  throw createUserError(
    `Multiple profiles found for agent "${agent}": ${candidates.join(', ')}.
Specify which profile to use:
  agenv run --profile <profile>              # run a specific profile
  agenv default local <profile> --for ${agent}   # set a project agent default
  agenv default global <profile> --for ${agent}  # set a global agent default`,
    { seeCommand: seeCommand || 'run' },
  );
}

function getResolvedProfileSettings(
  config: AgenvConfig,
  profile: string,
): ProfileSettings {
  const profileConfig = config.profiles?.[profile];
  return {
    args: profileConfig?.hasArgs ? profileConfig.args : '',
    env: { ...(profileConfig?.env || {}) },
  };
}

function sourceLabel(source: string | null): string {
  if (!source) return 'unknown';
  if (source === 'project.defaultProfile') return 'project default';
  if (source === 'global.defaultProfile') return 'global default';
  if (source.startsWith('project.agentDefaults.'))
    return 'project agent default';
  if (source.startsWith('global.agentDefaults.')) return 'global agent default';
  if (source.startsWith('single.')) return 'single';
  return source;
}

export {
  readInstalledProfiles,
  resolveProfileRecord,
  resolveProfileNameDetailed,
  resolveProfileForAgentDetailed,
  getResolvedProfileSettings,
  sourceLabel,
};
