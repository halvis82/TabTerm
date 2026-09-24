import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { debug, warn } from './log.js';
import { safeError } from './safe-error.js';

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
 *
 * **Interactive, because that is the shell a person has.** `.zshrc` is read by interactive shells
 * only, and it is where `export PATH="$HOME/.local/bin:$PATH"` lives on this machine and on most
 * others. Asking a login shell that is not interactive answered with a PATH nobody has: it put
 * `/usr/local/bin` ahead of `~/.local/bin`, so `claude` resolved to a copy from May 2025 that had
 * been superseded fifteen months earlier and still asked for a model that no longer exists. Every
 * prompt came back `API Error: 404 ... model: claude-opus-4-20250514`, in a conversation started
 * minutes before. A terminal inside TabTerm found the right one all along, because a terminal is
 * interactive; only what the daemon spawned itself was affected.
 *
 * The answer is fenced with a marker, since an interactive shell prints whatever somebody's
 * profile prints. A shell whose profile refuses to run interactively falls back to the plain
 * login shell, and then to a guess.
 */

/** Fences the answer off from whatever an interactive profile decides to print. */
const MARK = '__tabterm_path__';

let cached: string | null = null;

/** Kept small: this runs a shell, and the answer does not change while the host lives. */
export function loginPath(shell = process.env['SHELL'] ?? '/bin/zsh'): string {
  if (cached !== null) return cached;
  cached =
    ask(shell, ['-l', '-i', '-c', `printf '\n%s%s\n' ${MARK} "$PATH"`], true) ??
    ask(shell, ['-l', '-c', 'printf %s "$PATH"'], false) ??
    fallback();
  debug('login-path.resolved', { entries: cached.split(':').length });
  return cached;
}

/** One attempt at asking a shell, or null when it could not answer. */
function ask(shell: string, argv: readonly string[], fenced: boolean): string | null {
  try {
    // Constant arguments, never anything a user typed. See docs/05-security.md §4.
    const out = execFileSync(shell, [...argv], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const answer = fenced ? afterMark(out) : out.trim();
    return answer === '' ? null : answer;
  } catch (e: unknown) {
    warn('login-path.failed', { shell, interactive: fenced, error: safeError(e) });
    return null;
  }
}

/** The PATH out of a shell's output, ignoring anything its profile printed around it. */
export function afterMark(output: string, mark = MARK): string {
  const line = output.split('\n').find((l) => l.startsWith(mark));
  return line === undefined ? '' : line.slice(mark.length).trim();
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
