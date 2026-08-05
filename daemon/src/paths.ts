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
 * The argv for opening a path a given way.
 *
 * Pure, so the exact command for every modifier can be asserted without spawning anything.
 * Every value the user could have influenced arrives as its own argv element, never
 * interpolated into a string, so a filename containing quotes, spaces, or a semicolon is inert.
 * See docs/05-security.md §4.
 */
export function openCommand(
  absolute: string,
  how: OpenHow,
  opts: {
    editor: string;
    guiEditor: string;
    line?: number | undefined;
    column?: number | undefined;
  },
): { file: string; args: string[] } | null {
  switch (how) {
    case 'reveal-in-finder':
      return { file: '/usr/bin/open', args: ['-R', absolute] };

    case 'default-app':
      return { file: '/usr/bin/open', args: [absolute] };

    case 'editor': {
      // vim and its relatives take +N before the filename. The line is a number this code
      // parsed, never text from the terminal, so it cannot carry anything else.
      const args = opts.line !== undefined ? [`+${String(opts.line)}`, absolute] : [absolute];
      return { file: opts.editor, args };
    }

    case 'gui-editor': {
      // VS Code and its forks understand -g file:line:column.
      const target =
        opts.line !== undefined
          ? `${absolute}:${String(opts.line)}${opts.column !== undefined ? `:${String(opts.column)}` : ''}`
          : absolute;
      return { file: opts.guiEditor, args: opts.line !== undefined ? ['-g', target] : [target] };
    }

    case 'new-terminal':
      // Handled by the daemon spawning a session, not by running anything here.
      return null;
  }
}

/**
 * Open a path the user explicitly clicked.
 *
 * The path is always a distinct argv element, never interpolated into a shell string.
 */
export async function openPath(
  absolute: string,
  how: OpenHow,
  opts: {
    editor: string;
    guiEditor: string;
    line?: number | undefined;
    column?: number | undefined;
  },
): Promise<void> {
  // Re-verify at click time. The path was checked when it was made clickable, but the
  // filesystem may have changed since, and a stale claim must not become a spawn.
  try {
    await stat(absolute);
  } catch {
    warn('path.open.missing', { how });
    throw new Error('path-not-found');
  }

  const command = openCommand(absolute, how, opts);
  if (!command) return; // 'new-terminal' is handled by the daemon spawning a session.

  await new Promise<void>((res, rej) => {
    execFile(command.file, command.args, { timeout: 10_000 }, (err) => {
      if (err) {
        warn('path.open.failed', { how, error: err.message });
        rej(new Error('open-failed'));
      } else {
        info('path.opened', { how });
        res();
      }
    });
  });
}
