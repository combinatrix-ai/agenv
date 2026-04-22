import pkg from '../package.json';
import { fetchLatestVersion, isNewerVersion } from './updateCheck';

async function maybeNotifySelfUpdate() {
  if (process.env.AGENV_NO_SELF_UPDATE_CHECK) return;

  try {
    let latestVersion: string | null = null;
    try {
      latestVersion = await fetchLatestVersion(pkg.name);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (process.env.AGENV_DEBUG) {
        console.warn(`Warning: failed to check for agenv updates: ${message}`);
      }
    }

    if (latestVersion && isNewerVersion(latestVersion, pkg.version)) {
      console.error(
        `A new version of agenv is available: ${pkg.version} -> ${latestVersion}.`,
      );
      console.error(
        `Update with the package manager you used to install agenv (e.g. \`npm install -g ${pkg.name}@latest\`).`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.env.AGENV_DEBUG) {
      console.warn(`Warning: agenv update check failed: ${message}`);
    }
  }
}

export { maybeNotifySelfUpdate };
