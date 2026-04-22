export interface ProfileConfig {
  hasArgs: boolean;
  args: string;
  env: Record<string, string>;
}

interface ConfigSources {
  defaultProfile: string | null;
  agentDefaults: Record<string, string>;
}

export interface AgenvConfig {
  defaultProfile: string | null;
  agentDefaults: Record<string, string>;
  profiles: Record<string, ProfileConfig>;
  path: string | null;
  sources: ConfigSources;
}

export interface ProfileRecord {
  profile: string;
  name: string;
  package: string;
  version: string;
  pinned: boolean;
  installedAt: string;
  profilePath: string;
  agentPath: string;
  configPath: string;
}

export interface ResolvedProfile {
  profile: string;
  source: string;
}

export interface ProfileSettings {
  args: string;
  env: Record<string, string>;
}

export interface UpdateProfileResult {
  changed: boolean;
  savedArgsApplied: boolean;
  envKeys: string[];
}

export interface UpdateProfileOptions {
  savedArgs?: string[] | null;
  clearArgs?: boolean;
  envInput?: string[] | string | null;
  setDefault?: boolean;
  agent?: string | null;
}
