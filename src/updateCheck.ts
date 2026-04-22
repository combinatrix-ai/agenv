import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { isENOENT } from './errors';

function isNewerVersion(remote: string, local: string): boolean {
  if (!remote || !local) return false;
  const strip = (v: string) => v.replace(/^v/, '').replace(/-.*$/, '');
  const r = strip(remote).split('.');
  const l = strip(local).split('.');
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i += 1) {
    const rv = Number.parseInt(r[i] || '0', 10);
    const lv = Number.parseInt(l[i] || '0', 10);
    if (Number.isNaN(rv) || Number.isNaN(lv)) {
      return remote !== local;
    }
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

async function readInstalledVersion(
  agentPath: string,
  packageName: string,
): Promise<string | null> {
  const pkgJsonPath = path.join(
    agentPath,
    'node_modules',
    packageName,
    'package.json',
  );
  try {
    const raw = await fs.readFile(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.version || null;
  } catch (err: unknown) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

async function fetchLatestVersion(packageName: string): Promise<string | null> {
  const encoded = encodeURIComponent(packageName).replace('%40', '@');
  const url = `https://registry.npmjs.org/${encoded}/latest`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.npm.install-v1+json, application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const parsed = await res.json();
    return parsed.version || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function askUserToUpdate(
  profile: string,
  agentName: string,
  currentVersion: string,
  latestVersion: string,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(
      `Update available for ${agentName} (profile "${profile}"): ${currentVersion} -> ${latestVersion}\nUpdate now? [Y/n] `,
    );
    const trimmed = answer.trim().toLowerCase();
    return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

export {
  isNewerVersion,
  readInstalledVersion,
  fetchLatestVersion,
  askUserToUpdate,
};
