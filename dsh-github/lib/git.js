/**
 * git operations for dsh-github: the "远程连接仓库" download.
 *
 * `clone` runs a real `git clone --progress` and forwards each output line, so
 * the Settings page can show the download as it happens instead of a spinner
 * that says nothing. `listClones` reads back what is already on disk so the
 * page can list previously connected repositories without keeping a second
 * registry that could drift out of sync with the filesystem.
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Collect `git clone` arguments; `--progress` forces progress on a pipe. */
export function cloneArgv(options) {
  const argv = ['clone', '--progress'];
  if (typeof options.branch === 'string' && options.branch !== '') {
    argv.push('--branch', options.branch);
  }
  if (typeof options.depth === 'number' && options.depth > 0) {
    argv.push('--depth', String(options.depth));
  }
  argv.push('--', options.url, options.dest);
  return argv;
}

/** Trailing path segment of a path, tolerating both separators. */
export function baseName(path) {
  const parts = String(path).split(/[\\/]+/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? '';
}

export function createGitRunner(options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const binary = options.binary ?? 'git';

  return {
    binary,

    /** `git --version`, or an Error explaining why it is unusable. */
    async version() {
      return new Promise((resolve) => {
        let child;
        try {
          child = spawnImpl(binary, ['--version'], { windowsHide: true });
        } catch (error) {
          resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
          return;
        }
        let out = '';
        child.stdout?.on('data', (chunk) => { out += String(chunk); });
        child.stderr?.on('data', (chunk) => { out += String(chunk); });
        child.on('error', (error) => resolve({ ok: false, reason: error.message }));
        child.on('close', (code) => {
          if (code === 0) resolve({ ok: true, version: out.trim() });
          else resolve({ ok: false, reason: out.trim() === '' ? `git exited with ${String(code)}` : out.trim() });
        });
      });
    },

    /**
     * Run one clone, streaming output lines to `onLine`.
     * @returns `{ code, log }`; a non-zero code is a failed clone, not a throw.
     */
    async clone(spec, onLine = () => {}) {
      const argv = cloneArgv(spec);
      return new Promise((resolve) => {
        let child;
        try {
          child = spawnImpl(binary, argv, {
            cwd: spec.cwd,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
          });
        } catch (error) {
          resolve({ code: -1, log: `无法启动 git：${error instanceof Error ? error.message : String(error)}` });
          return;
        }
        const lines = [];
        const feed = (chunk) => {
          for (const line of String(chunk).split(/\r?\n|\r/)) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            lines.push(trimmed);
            if (lines.length > 400) lines.shift();
            onLine(trimmed);
          }
        };
        child.stdout?.on('data', feed);
        child.stderr?.on('data', feed);
        child.on('error', (error) => {
          resolve({ code: -1, log: `git 进程错误：${error.message}` });
        });
        child.on('close', (code) => {
          resolve({ code: code === null ? -1 : code, log: lines.join('\n') });
        });
        if (typeof spec.onSpawn === 'function') spec.onSpawn(child);
      });
    },

    /**
     * Rewrite one clone's `origin` URL.
     *
     * A private clone carries the token inside its URL, and `git clone` writes
     * that URL into `.git/config`. This is the scrub that puts the clean URL
     * back, so a downloaded repository never keeps a credential in its config.
     */
    async setRemoteUrl(directory, url, onLine = () => {}) {
      return new Promise((resolve) => {
        let child;
        try {
          child = spawnImpl(binary, ['-C', directory, 'remote', 'set-url', 'origin', url], { windowsHide: true });
        } catch (error) {
          resolve({ code: -1, log: error instanceof Error ? error.message : String(error) });
          return;
        }
        const lines = [];
        const feed = (chunk) => {
          const text = String(chunk).trim();
          if (text === '') return;
          lines.push(text);
          onLine(text);
        };
        child.stdout?.on('data', feed);
        child.stderr?.on('data', feed);
        child.on('error', (error) => resolve({ code: -1, log: error.message }));
        child.on('close', (code) => resolve({ code: code === null ? -1 : code, log: lines.join('\n') }));
      });
    },
  };
}

/** Current branch as recorded in `.git/HEAD`, or `undefined` when detached. */
async function headBranch(gitDir) {
  try {
    const text = await readFile(join(gitDir, 'HEAD'), 'utf8');
    const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(text.trim());
    return match === null ? undefined : match[1].trim();
  } catch {
    return undefined;
  }
}

/** `origin` URL as recorded in `.git/config`, or `undefined`. */
async function originUrl(gitDir) {
  try {
    const text = await readFile(join(gitDir, 'config'), 'utf8');
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(text);
    if (section === null) return undefined;
    const url = /^\s*url\s*=\s*(.+)$/m.exec(section[1]);
    return url === null ? undefined : url[1].trim();
  } catch {
    return undefined;
  }
}

/**
 * Every git working copy directly under `root`.
 * @returns `{ name, path, remote, branch, updatedAt }[]`, newest first.
 */
export async function listClones(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue;
    const path = join(root, entry.name);
    const gitDir = join(path, '.git');
    let info;
    try {
      info = await stat(gitDir);
    } catch {
      continue;
    }
    if (info.isDirectory() !== true) continue;
    found.push({
      name: entry.name,
      path,
      remote: await originUrl(gitDir),
      branch: await headBranch(gitDir),
      updatedAt: info.mtimeMs,
    });
  }
  found.sort((left, right) => right.updatedAt - left.updatedAt);
  return found;
}
