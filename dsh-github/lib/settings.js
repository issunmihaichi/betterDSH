/**
 * On-disk store for dsh-github.
 *
 * Two files under one directory (default `<DSH_HOME>/github-mcp`):
 *
 *   settings.json  everything that is not a secret, so it can be shown,
 *                  diffed and edited by hand.
 *   token          the GitHub personal access token, alone, mode 0600.
 *
 * The token is deliberately NOT part of settings.json: the settings file is
 * returned to the browser half on every status poll, and keeping the secret in
 * a separate file makes "what did we just send to the page" auditable.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Default store directory beneath a DSH home. */
export function defaultStoreDir(dshHome) {
  return join(dshHome, 'github-mcp');
}

/** `node:fs/promises`-shaped dependency, injectable so tests stay off the disk. */
export const nodeFs = { chmod, mkdir, readFile, rm, writeFile };

export function createStore(options) {
  const dir = options.dir;
  const fs = options.fs ?? nodeFs;
  const settingsPath = join(dir, 'settings.json');
  const tokenPath = join(dir, 'token');

  const readText = async (path) => {
    try {
      return await fs.readFile(path, 'utf8');
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined;
      throw error;
    }
  };

  return {
    dir,
    settingsPath,
    tokenPath,

    /** Persisted settings, or `{}` when nothing has been saved yet. */
    async load() {
      const text = await readText(settingsPath);
      if (text === undefined || text.trim() === '') return {};
      try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch {
        // A corrupt file must not take the whole plugin down: start over from
        // defaults and let the next save overwrite it.
        return {};
      }
    },

    /** Write the complete settings document. */
    async save(settings) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return settings;
    },

    /** The stored token, or `undefined`. */
    async readToken() {
      const text = await readText(tokenPath);
      if (text === undefined) return undefined;
      const value = text.trim();
      return value === '' ? undefined : value;
    },

    /** Store a token with owner-only permissions. */
    async writeToken(token) {
      const value = String(token).trim();
      if (value === '') return this.clearToken();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tokenPath, value, { encoding: 'utf8', mode: 0o600 });
      // Windows ignores the mode above; chmod is the best-effort equivalent.
      try {
        await fs.chmod(tokenPath, 0o600);
      } catch { /* best effort only */ }
      return value;
    },

    async clearToken() {
      try {
        await fs.rm(tokenPath, { force: true });
      } catch (error) {
        if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
      }
      return undefined;
    },
  };
}
