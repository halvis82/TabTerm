import ptyPkg from 'node-pty';
import type { IPty } from 'node-pty';
import { info, warn } from './log.js';

const { spawn } = ptyPkg;

export interface PtyOptions {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  command?: readonly string[];
  env?: Record<string, string>;
  sessionId: string;
}

export interface PtyHandle {
  readonly pty: IPty;
  readonly pid: number;
}

/**
 * A LaunchAgent starts with a minimal PATH. Only a LOGIN shell reconstructs the real one via
 * /etc/zprofile, path_helper, and user dotfiles. Measured: 26 entries versus 14.
 * Whether a non-login shell happens to work depends on whether the user edits .zshrc or
 * .zprofile, which is exactly why it cannot be relied on. See docs/13-packaging.md.
 */
export function spawnPty(opts: PtyOptions): PtyHandle {
  const env: Record<string, string> = {
    ...filteredEnv(),
    ...opts.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TABTERM_SESSION: opts.sessionId,
    TABTERM_VERSION: '0.0.0',
  };

  // argv, never a shell string. See docs/05-security.md §4.
  const [file, args] = opts.command?.length
    ? [opts.command[0] as string, opts.command.slice(1)]
    : [opts.shell, ['-l']];

  const pty = spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env,
  });

  info('pty.spawned', {
    sessionId: opts.sessionId,
    pid: pty.pid,
    cols: opts.cols,
    rows: opts.rows,
  });
  return { pty, pid: pty.pid };
}

/**
 * Variables that describe how the daemon runs, not how the user's shell should.
 *
 * A terminal must hand you *your* environment. The daemon happens to be a Node process, and
 * when it runs from the app bundle its launcher sets `NODE_PATH` so it can find its own native
 * `node-pty`. Passing that to a shell puts TabTerm's `node_modules` on the module resolution
 * path of every `node` command you run, which produces the worst kind of bug: a project
 * resolving a dependency it never installed, from a directory it has no idea exists.
 *
 * `NODE_OPTIONS` is here for the same reason -- it would silently apply to every Node process
 * started in a terminal.
 */
const DAEMON_ONLY_VARS = ['NODE_PATH', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE'];

/** The auth token is never placed in a PTY environment. See docs/08-shell-integration.md §7. */
function filteredEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('TABTERM_')) continue;
    if (DAEMON_ONLY_VARS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Escalate rather than SIGKILL immediately, so a shell gets a chance to run its exit hooks.
 * The process GROUP is signalled, not just the leader, or orphaned children survive.
 */
export async function killPty(handle: PtyHandle, sessionId: string): Promise<void> {
  const stages: NodeJS.Signals[] = ['SIGHUP', 'SIGTERM', 'SIGKILL'];
  for (const sig of stages) {
    if (!isAlive(handle.pid)) return;
    try {
      process.kill(-handle.pid, sig);
    } catch {
      try {
        handle.pty.kill(sig);
      } catch {
        /* already gone */
      }
    }
    await new Promise((r) => setTimeout(r, sig === 'SIGKILL' ? 200 : 800));
  }
  if (isAlive(handle.pid)) warn('pty.kill.survived', { sessionId, pid: handle.pid });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
