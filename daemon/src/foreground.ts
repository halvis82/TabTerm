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
interface Row {
  pid: number;
  ppid: number;
  foreground: boolean;
  command: string;
}

/**
 * One sweep of the process table, shared by everything that asks within the same moment.
 *
 * `ps -ax` lists every process on the machine, and this was run once per session that had a
 * command in flight, every second, each time parsed from scratch. Four sessions running something
 * meant four forks a second and four passes over the whole table. The answer is the same table
 * for all of them.
 *
 * Two parts, and both matter. A short life, so a probe a moment later reuses the sweep rather
 * than starting another; and one in flight at a time, so probes that land together share the one
 * that is already running rather than each beginning their own.
 *
 * The window is a quarter of the second the poll uses, which keeps it well inside the slack the
 * tracker already documents: a late end costs a slightly late "finished", never a wrong duration.
 */
const TABLE_TTL_MS = 250;
let tableAt = 0;
let table: Map<number, Row[]> | null = null;
let sweeping: Promise<Map<number, Row[]> | null> | null = null;

async function processTable(now = Date.now()): Promise<Map<number, Row[]> | null> {
  if (table && now - tableAt < TABLE_TTL_MS) return table;
  sweeping ??= (async () => {
    try {
      const out = await run('/bin/ps', ['-o', 'pid=,ppid=,stat=,args=', '-ax']);
      if (!out) return null;
      const byParent = new Map<number, Row[]>();
      for (const line of out.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!match?.[1] || !match[2] || !match[3]) continue;
        const row: Row = {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          foreground: match[3].includes('+'),
          command: (match[4] ?? '').trim(),
        };
        const siblings = byParent.get(row.ppid);
        if (siblings) siblings.push(row);
        else byParent.set(row.ppid, [row]);
      }
      table = byParent;
      tableAt = Date.now();
      return byParent;
    } finally {
      sweeping = null;
    }
  })();
  return await sweeping;
}

/** Forget the sweep, so a test that changes what is running is not answered from before it. */
export function forgetProcessTable(): void {
  table = null;
  tableAt = 0;
}

export async function foregroundOf(shellPid: number): Promise<ForegroundProcess | null> {
  const byParent = await processTable();
  if (!byParent) return null;

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
