import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAgentsDir, pathExists, readJson, writeJson } from './state';

type InstallTarget = {
  profile: string;
  name?: string;
  package: string;
  version: string;
  pinned?: boolean;
  profilePath?: string;
  agentPath?: string;
  configPath?: string;
};

type EnsureInstalledOptions = {
  force?: boolean;
};

async function ensureBaseDirs() {
  await fs.mkdir(getAgentsDir(), { recursive: true });
}

function sanitizeName(name: string) {
  return name.replace(/[\\/]/g, '__');
}

function profilePaths(profile: string) {
  const profilePath = path.join(getAgentsDir(), sanitizeName(profile));
  return {
    profilePath,
    agentPath: path.join(profilePath, 'agent'),
    configPath: path.join(profilePath, 'config'),
  };
}

async function npmInstall(agentPath: string, pkgSpec: string) {
  await fs.mkdir(agentPath, { recursive: true });
  const args = [
    'install',
    '--prefix',
    agentPath,
    '--no-package-lock',
    '--no-progress',
    '--no-fund',
    '--include=optional',
    pkgSpec,
  ];
  await runCommand('npm', args, { stdio: 'inherit' });
}

function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions = {},
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${command} ${args.join(' ')} exited with code ${code}`),
        );
      }
    });
    child.on('error', (err) => reject(err));
  });
}

async function resolveInstalledVersion(
  agentPath: string,
  packageName: string,
  requestedVersion: string,
): Promise<string> {
  try {
    const pkgJsonPath = path.join(
      agentPath,
      'node_modules',
      packageName,
      'package.json',
    );
    const raw = await fs.readFile(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.version === 'string') return parsed.version;
  } catch {
    // fall through
  }
  return requestedVersion;
}

async function ensureInstalled(
  target: InstallTarget,
  { force }: EnsureInstalledOptions = {},
) {
  await ensureBaseDirs();
  const defaults = profilePaths(target.profile);
  const profilePath = target.profilePath || defaults.profilePath;
  const agentPath = target.agentPath || defaults.agentPath;
  const configPath = target.configPath || defaults.configPath;
  const metaPath = path.join(profilePath, 'profile.json');
  const hasInstall = await pathExists(agentPath);
  const existingMeta = await readJson(metaPath, null);

  const needsReinstall =
    force ||
    !hasInstall ||
    !existingMeta ||
    existingMeta.package !== target.package ||
    existingMeta.version !== target.version;

  if (needsReinstall) {
    if (hasInstall) {
      await fs.rm(agentPath, { recursive: true, force: true });
    }
    const pkgSpec = `${target.package}@${target.version}`;
    console.log(`> Installing ${pkgSpec} into ${agentPath}`);
    await npmInstall(agentPath, pkgSpec);
  }
  await fs.mkdir(configPath, { recursive: true });

  const resolvedVersion = await resolveInstalledVersion(
    agentPath,
    target.package,
    target.version,
  );

  const meta = {
    profile: target.profile,
    agent: target.name,
    package: target.package,
    version: resolvedVersion,
    pinned: Boolean(target.pinned),
    installedAt:
      typeof existingMeta?.installedAt === 'string'
        ? existingMeta.installedAt
        : new Date().toISOString(),
    profilePath,
    agentPath,
    configPath,
  };
  await writeJson(metaPath, meta);
  return { agentPath, meta, installed: needsReinstall };
}

async function findAgentBinary(agentPath: string, packageName: string) {
  const pkgJsonPath = path.join(
    agentPath,
    'node_modules',
    packageName,
    'package.json',
  );
  let binRelative: string | null = null;

  try {
    const raw = await fs.readFile(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.bin === 'string') {
      binRelative = parsed.bin;
    } else if (parsed.bin && typeof parsed.bin === 'object') {
      const binEntry = Object.values(parsed.bin)[0];
      if (typeof binEntry === 'string') {
        binRelative = binEntry;
      }
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      console.warn(`Warning: unable to read ${pkgJsonPath}: ${error.message}`);
    }
  }

  if (binRelative) {
    const candidate = path.join(
      agentPath,
      'node_modules',
      packageName,
      binRelative,
    );
    if (await pathExists(candidate)) return candidate;
  }

  const fallbackName = packageName.includes('/')
    ? packageName.split('/').pop() || packageName
    : packageName;
  const fallback = path.join(agentPath, 'node_modules', '.bin', fallbackName);
  if (await pathExists(fallback)) return fallback;

  return null;
}

async function writeAgentAutoUpdateConfig(
  agentName: string,
  configPath: string,
) {
  if (agentName === 'codex') {
    const tomlPath = path.join(configPath, 'config.toml');
    const marker = 'check_for_update_on_startup = false';
    let existing = '';
    try {
      existing = await fs.readFile(tomlPath, 'utf8');
    } catch (err: unknown) {
      if (!((err as NodeJS.ErrnoException).code === 'ENOENT')) throw err;
    }
    if (!existing.includes(marker)) {
      const content = existing
        ? `${existing.trimEnd()}\n${marker}\n`
        : `${marker}\n`;
      await fs.writeFile(tomlPath, content);
    }
  }

  if (agentName === 'gemini') {
    const geminiDir = path.join(configPath, '.gemini');
    await fs.mkdir(geminiDir, { recursive: true });
    const settingsPath = path.join(geminiDir, 'settings.json');
    let settings: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      settings = JSON.parse(raw);
    } catch (err: unknown) {
      if (!((err as NodeJS.ErrnoException).code === 'ENOENT')) throw err;
    }
    const general =
      (settings.general as Record<string, unknown> | undefined) || {};
    general.enableAutoUpdateNotification = false;
    general.enableAutoUpdate = false;
    settings.general = general;
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

export {
  ensureInstalled,
  findAgentBinary,
  profilePaths,
  runCommand,
  writeAgentAutoUpdateConfig,
};
