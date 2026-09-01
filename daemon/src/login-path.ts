import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { debug, warn } from './log.js';

/**
 * The PATH a person actually has, rather than the one launchd hands the daemon.
 *
 * A LaunchAgent starts with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A terminal never noticed,
 * because a shell is spawned with `-l` and rebuilds its own environment on the way up. Anything
 * spawned as a command did notice: `claude`, `codex`, and every command a project template
 * declares live in `~/.local/bin` or Homebrew, none of which are on that PATH, so they failed to
 * spawn at all. See docs/13-packaging.md.
 *
 * Asking the login shell is the same mechanism a terminal already relies on, so what a command
 * gets and what a person gets in a shell are the same thing by construction rather than by a
 * list somebody has to maintain.
 */

let cached: string | null = null;

/** Kept small: this runs a shell, and the answer does not change while the host lives. */
export function loginPath(shell = process.env['SHELL'] ?? '/bin/zsh'): string {
  if (cached !== null) return cached;
  try {
    // A constant argument, never anything a user typed. See docs/05-security.md §4.
    const out = execFileSync(shell, ['-l', '-c', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cached = out.trim() || fallback();
  } catch (e: unknown) {
    warn('login-path.failed', { shell, error: String(e) });
    cached = fallback();
  }
  debug('login-path.resolved', { entries: cached.split(':').length });
  return cached;
}

function fallback(): string {
  // Better than launchd's, and still honest about being a guess.
  return [
    join(process.env['HOME'] ?? '', '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin',
  ]
    .filter((p) => p !== '')
    .join(':');
}

/**
 * Where a command actually is, or null.
 *
 * Resolved here rather than left to the spawn, because `posix_spawnp` searches the PATH of the
 * process doing the spawning and not the one being handed to the child. Putting the right PATH
 * in the child's environment therefore fixes what the child's own subprocesses can find, and
 * does nothing for finding the child itself.
 */
export function resolveExecutable(file: string, path = loginPath()): string | null {
  if (file.includes('/')) return isAbsolute(file) ? file : null;
  for (const dir of path.split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, file);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable. Try the next one.
    }
  }
  return null;
}

/** Test seam, so a test does not inherit whatever the machine happens to have. */
export function resetLoginPathCache(): void {
  cached = null;
}
