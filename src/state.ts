import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isENOENT } from './errors';

function getAgenvHome() {
  return process.env.AGENV_HOME || path.join(os.homedir(), '.agenv');
}

export function getAgentsDir() {
  return path.join(getAgenvHome(), 'agents');
}

export function getGlobalConfigFile() {
  return path.join(getAgenvHome(), '.agenv.json');
}

export async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(
  file: string,
  fallback: T | null = null,
) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err: unknown) {
    if (isENOENT(err)) return fallback;
    throw err;
  }
}

export async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}
