import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';
import type { OpenHow, ResolvedPath } from '@tabterm/shared';
import { info, warn } from './log.js';

/**
 * Turning printed text into openable paths.
 *
 * Terminal output is attacker-controlled the moment you `cat` a file, so a detected path is a
 * CANDIDATE, never a fact. Nothing is offered to the user until the daemon has resolved it
 * against the session's directory and confirmed it exists on disk. See docs/05-security.md §4.
 */

const MAX_CANDIDATES = 200;
const MAX_LENGTH = 4096;

/** `src/main.ts`, `src/main.ts:42`, `src/main.ts:42:7`. */
const LINE_COL = /^(.*?):(\d+)(?::(\d+))?$/;

export async function resolvePaths(
  candidates: readonly string[],
  cwd: string,
): Promise<ResolvedPath[]> {
  const unique = [...new Set(candidates)].slice(0, MAX_CANDIDATES);
  const out = await Promise.all(unique.map((c) => resolveOne(c, cwd)));
  return out.filter((r): r is ResolvedPath => r !== null);
}

async function resolveOne(candidate: string, cwd: string): Promise<ResolvedPath | null> {
  if (candidate.length === 0 || candidate.length > MAX_LENGTH) return null;
  if (candidate.includes('\0')) return null;

  // Split a trailing :line:col before touching the filesystem, so `foo.ts:42` resolves.
  let bare = candidate;
  let line: number | undefined;
  let column: number | undefined;
  const m = LINE_COL.exec(candidate);
  if (m?.[1]) {
    bare = m[1];
    line = Number(m[2]);
    if (m[3]) column = Number(m[3]);
  }

  const absolute = toAbsolute(bare, cwd);
  if (!absolute) return null;

  try {
    const st = await stat(absolute);
    return {
      candidate,
      absolute,
      exists: true,
      isDirectory: st.isDirectory(),
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
    };
  } catch {
    // Does not exist. Report it so the frontend stops asking, but it is never made clickable.
    return { candidate, absolute, exists: false, isDirectory: false };
  }
}

function toAbsolute(candidate: string, cwd: string): string | null {
  let expanded = candidate;
  if (expanded === '~') expanded = homedir();
  else if (expanded.startsWith('~/')) expanded = resolve(homedir(), expanded.slice(2));

  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
  if (!absolute.startsWith('/')) return null;
  return absolute;
}

/**
 * Open a path the user explicitly clicked.
 *
 * `open` receives the path as a distinct argv element. It is never interpolated into a shell
 * string, so a filename containing metacharacters, spaces, or newlines is inert.
 */
export async function openPath(absolute: string, how: OpenHow): Promise<void> {
  // Re-verify at click time. The path was checked when it was made clickable, but the
  // filesystem may have changed since, and a stale claim must not become a spawn.
  try {
    await stat(absolute);
  } catch {
    warn('path.open.missing', { how });
    throw new Error('path-not-found');
  }

  const args = how === 'reveal-in-finder' ? ['-R', absolute] : [absolute];

  await new Promise<void>((res, rej) => {
    execFile('/usr/bin/open', args, { timeout: 10_000 }, (err) => {
      if (err) {
        warn('path.open.failed', { how, error: err.message });
        rej(new Error('open-failed'));
      } else {
        info('path.opened', { how, isDir: how === 'reveal-in-finder' });
        res();
      }
    });
  });
}
