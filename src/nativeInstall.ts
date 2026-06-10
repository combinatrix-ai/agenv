import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUserError } from './errors';
import { profilePaths, runCommand } from './install';
import { pathExists, readJson, writeJson } from './state';

type NativeInstallTarget = {
  profile: string;
  name?: string;
  package: string;
  version: string;
  pinned?: boolean;
  profilePath?: string;
  agentPath?: string;
  configPath?: string;
};

type EnsureInstalledNativeOptions = {
  force?: boolean;
};

type NativeInstallResult = {
  binPath: string;
  version: string;
};

const CLAUDE_DOWNLOAD_BASE = 'https://downloads.claude.ai/claude-code-releases';
const CODEX_INSTALLER_URL = 'https://chatgpt.com/codex/install.sh';

function trimBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function platformString() {
  let osName: string;
  if (process.platform === 'darwin') {
    osName = 'darwin';
  } else if (process.platform === 'linux') {
    osName = 'linux';
  } else {
    throw createUserError('native channel is not supported on this platform');
  }

  let archName: string;
  if (process.arch === 'arm64') {
    archName = 'arm64';
  } else if (process.arch === 'x64') {
    archName = 'x64';
  } else {
    throw createUserError('native channel is not supported on this platform');
  }

  return `${osName}-${archName}`;
}

async function fetchOk(url: string) {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw createUserError(`Failed to download ${url}: ${message}`);
  }
  if (!response.ok) {
    throw createUserError(`Failed to download ${url}: HTTP ${response.status}`);
  }
  return response;
}

async function fetchText(url: string) {
  const response = await fetchOk(url);
  return response.text();
}

async function fetchBytes(url: string) {
  const response = await fetchOk(url);
  return Buffer.from(await response.arrayBuffer());
}

function parseManifest(raw: string, version: string) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw createUserError(
    `Invalid native manifest for claude version ${version}`,
  );
}

function checksumForPlatform(
  manifest: Record<string, unknown>,
  platform: string,
  version: string,
) {
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== 'object') {
    throw createUserError(
      `Native claude release ${version} is missing platform data`,
    );
  }
  const entry = (platforms as Record<string, unknown>)[platform];
  if (!entry || typeof entry !== 'object') {
    throw createUserError(
      `Native claude release ${version} is not supported on ${platform}`,
    );
  }
  const checksum = (entry as Record<string, unknown>).checksum;
  if (typeof checksum !== 'string' || !/^[a-fA-F0-9]{64}$/.test(checksum)) {
    throw createUserError(
      `Native claude release ${version} has an invalid checksum`,
    );
  }
  return checksum.toLowerCase();
}

async function resolveClaudeVersion(baseUrl: string, requestedVersion: string) {
  if (requestedVersion !== 'latest') return requestedVersion;
  const version = (await fetchText(`${baseUrl}/latest`)).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw createUserError(
      `Invalid native claude latest version: ${version || '(empty)'}`,
    );
  }
  return version;
}

async function installClaudeNative(
  agentPath: string,
  requestedVersion: string,
) {
  const baseUrl = trimBaseUrl(
    process.env.AGENV_CLAUDE_DOWNLOAD_BASE || CLAUDE_DOWNLOAD_BASE,
  );
  const platform = platformString();
  const version = await resolveClaudeVersion(baseUrl, requestedVersion);
  const manifest = parseManifest(
    await fetchText(`${baseUrl}/${version}/manifest.json`),
    version,
  );
  const expectedChecksum = checksumForPlatform(manifest, platform, version);
  const bytes = await fetchBytes(`${baseUrl}/${version}/${platform}/claude`);
  const actualChecksum = createHash('sha256').update(bytes).digest('hex');
  if (actualChecksum !== expectedChecksum) {
    throw createUserError(
      `Downloaded claude checksum mismatch for ${platform}`,
    );
  }

  const binPath = path.join(agentPath, 'bin', 'claude');
  await fs.mkdir(path.dirname(binPath), { recursive: true });
  await fs.writeFile(binPath, bytes, { mode: 0o755 });
  await fs.chmod(binPath, 0o755);
  return { binPath, version };
}

async function downloadCodexInstaller() {
  const installerPath = process.env.AGENV_CODEX_INSTALLER_PATH;
  if (installerPath) {
    return { scriptPath: installerPath, cleanup: null };
  }

  const url = process.env.AGENV_CODEX_INSTALLER_URL || CODEX_INSTALLER_URL;
  const bytes = await fetchBytes(url);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenv-codex-'));
  const scriptPath = path.join(tmpDir, 'install.sh');
  await fs.writeFile(scriptPath, bytes, { mode: 0o755 });
  await fs.chmod(scriptPath, 0o755);
  return {
    scriptPath,
    cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }),
  };
}

async function resolveCodexInstalledVersion(
  binPath: string,
  requestedVersion: string,
) {
  return new Promise<string>((resolve) => {
    const child = spawn(binPath, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', () => resolve(requestedVersion));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(requestedVersion);
        return;
      }
      const matches = stdout.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g);
      resolve(matches?.[matches.length - 1] || requestedVersion);
    });
  });
}

async function installCodexNative(agentPath: string, requestedVersion: string) {
  const { scriptPath, cleanup } = await downloadCodexInstaller();
  const binPath = path.join(agentPath, 'bin', 'codex');
  // The installer writes a PATH export block into $HOME's shell profile
  // (unconditionally when another codex is anywhere on PATH), so it runs
  // with a sacrificial HOME that is discarded afterwards.
  const sandboxHome = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agenv-codex-home-'),
  );
  try {
    await runCommand(
      'bash',
      [
        scriptPath,
        ...(requestedVersion !== 'latest'
          ? ['--release', requestedVersion]
          : []),
      ],
      {
        env: {
          ...process.env,
          CODEX_HOME: agentPath,
          CODEX_INSTALL_DIR: path.join(agentPath, 'bin'),
          CODEX_NON_INTERACTIVE: '1',
          HOME: sandboxHome,
          // Keep the install dir first on PATH so the installer's
          // conflict detection sees this profile's codex as primary.
          PATH: `${path.join(agentPath, 'bin')}${path.delimiter}${
            process.env.PATH || ''
          }`,
        },
        stdio: 'inherit',
      },
    );
  } finally {
    if (cleanup) await cleanup();
    await fs.rm(sandboxHome, { recursive: true, force: true });
  }

  return {
    binPath,
    version: await resolveCodexInstalledVersion(binPath, requestedVersion),
  };
}

async function installNativeBinary(
  target: NativeInstallTarget,
  agentPath: string,
): Promise<NativeInstallResult> {
  if (target.name === 'claude') {
    return installClaudeNative(agentPath, target.version);
  }
  if (target.name === 'codex') {
    return installCodexNative(agentPath, target.version);
  }
  const agentLabel = target.name || target.profile;
  throw createUserError(`native channel is not supported for ${agentLabel}`, {
    seeCommand: 'install',
  });
}

async function resolveNativeVersion(target: NativeInstallTarget) {
  if (target.name === 'claude') {
    const baseUrl = trimBaseUrl(
      process.env.AGENV_CLAUDE_DOWNLOAD_BASE || CLAUDE_DOWNLOAD_BASE,
    );
    return resolveClaudeVersion(baseUrl, target.version);
  }
  return target.version;
}

function nativeBinPath(target: NativeInstallTarget, agentPath: string) {
  if (target.name === 'claude') return path.join(agentPath, 'bin', 'claude');
  if (target.name === 'codex') return path.join(agentPath, 'bin', 'codex');
  return path.join(agentPath, 'bin', target.name || target.profile);
}

async function ensureInstalledNative(
  target: NativeInstallTarget,
  { force }: EnsureInstalledNativeOptions = {},
) {
  const defaults = profilePaths(target.profile);
  const profilePath = target.profilePath || defaults.profilePath;
  const agentPath = target.agentPath || defaults.agentPath;
  const configPath = target.configPath || defaults.configPath;
  const metaPath = path.join(profilePath, 'profile.json');
  const existingMeta = await readJson<Record<string, unknown>>(metaPath, null);
  const requestedResolvedVersion = await resolveNativeVersion(target);
  const binPath = nativeBinPath(target, agentPath);
  const hasBinary = await pathExists(binPath);

  const needsReinstall =
    force ||
    !hasBinary ||
    existingMeta?.version !== requestedResolvedVersion ||
    existingMeta?.channel !== 'native';

  let result: NativeInstallResult = {
    binPath,
    version: requestedResolvedVersion,
  };
  if (needsReinstall) {
    if (await pathExists(agentPath)) {
      await fs.rm(agentPath, { recursive: true, force: true });
    }
    console.log(
      `> Installing ${target.name}@${target.version} via native channel into ${agentPath}`,
    );
    result = await installNativeBinary(target, agentPath);
  }

  await fs.mkdir(configPath, { recursive: true });
  const meta = {
    profile: target.profile,
    agent: target.name,
    package: target.package,
    version: result.version,
    pinned: Boolean(target.pinned),
    channel: 'native',
    binPath: result.binPath,
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

export { ensureInstalledNative };
