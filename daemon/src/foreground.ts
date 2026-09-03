import { execFile } from 'node:child_process';
import { debug } from './log.js';

/**
 * What a shell is running right now, without any shell configuration.
 *
 * OSC 133 is exact and instant, and it requires the user to have edited a dotfile. Most people
 * have not, and telling them their history, command timing, and server detection are "inert
 * until you edit `.zshrc`" is a bad answer to a problem the OS can already solve.
 *
 * The OS knows. A shell's foreground child is visible in `ps`, with its **full argv**, so the
 * command line comes back exactly rather than being reconstructed from keystrokes or scraped
 * off the screen. Both of those alternatives are heuristics that would put wrong commands in
 * someone's history, which is worse than putting none there.
 *
 * What this cannot see is a shell builtin — `cd`, `export`, `alias` — because no process is
 * spawned. That is a real gap and, for `export`, an improvement: the one command whose text is
 * most sensitive is the one that never appears.
 *
 * See docs/08-shell-integration.md.
 */

export interface ForegroundProcess {
  pid: number;
  /** The full command line, straight from the OS. */
  command: string;
}

/**
 * The foreground child of a shell, if it has one.
 *
 * `ps` marks the foreground process group with `+` in its state field, which is exactly the
 * question being asked: not "does this shell have children" but "is something running instead
 * of the prompt".
 */
export async function foregroundOf(shellPid: number): Promise<ForegroundProcess | null> {
  const out = await run('/bin/ps', ['-o', 'pid=,ppid=,stat=,args=', '-ax']);
  if (!out) return null;

  const rows: { pid: number; ppid: number; foreground: boolean; command: string }[] = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      foreground: match[3].includes('+'),
      command: (match[4] ?? '').trim(),
    });
  }

  const byParent = new Map<number, typeof rows>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid) ?? [];
    siblings.push(row);
    byParent.set(row.ppid, siblings);
  }

  // Walk down from the shell. A command is often a grandchild — `npm test` spawns node, and
  // `git log` spawns a pager — and the deepest foreground process is the one actually running.
  let best: ForegroundProcess | null = null;
  const visit = (pid: number, depth: number): void => {
    if (depth > 8) return;
    for (const child of byParent.get(pid) ?? []) {
      if (child.foreground && child.command) {
        best = { pid: child.pid, command: child.command };
      }
      visit(child.pid, depth + 1);
    }
  };
  visit(shellPid, 0);

  if (best) debug('foreground.found', { shellPid, command: (best as ForegroundProcess).command });
  return best;
}

function run(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/**
 * Commands not worth reporting as "a command is running".
 *
 * The shell spawns helpers of its own, and a prompt that runs `git branch` to decorate itself
 * would otherwise look like the user running a command every time they press Enter.
 */
/**
 * Programs that are not a command somebody ran and waited for.
 *
 * The shells are here as well as being checked by pid, because a login shell can appear under
 * several names and a wrapper can put a second one in the foreground. Reporting one as a
 * finished command produced notifications reading `Finished: /bin/zsh -l` with the age of the
 * session as their duration.
 */
const NOISE = new Set([
  'ps',
  'stty',
  'tput',
  'locale',
  'dircolors',
  'tset',
  'zsh',
  '-zsh',
  'bash',
  '-bash',
  'sh',
  '-sh',
  'fish',
  '-fish',
]);

export function isNoise(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const name = first.split('/').pop() ?? first;
  return NOISE.has(name);
}
