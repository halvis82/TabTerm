import { execFile } from 'node:child_process';

/**
 * One sweep of the process table, shared by everything that needs to look at it.
 *
 * `ps -ax` lists every process on the machine. Two paths here wanted that: the foreground probe,
 * which ran one per session with a command in flight every second, and the working directory
 * lookup, which ran one per session every time the start screen asked where its terminals are.
 * Seven sessions on a start screen meant seven sweeps of the same table, a fork each, all in the
 * same moment and all with the same answer.
 *
 * Two parts, and both matter. A short life, so anything asking a moment later reuses the sweep
 * rather than starting another; and one in flight at a time, so callers that land together share
 * the one already running rather than each beginning their own.
 *
 * The window is a quarter of a second, which is well inside the slack the callers already
 * document: the tracker's poll is a second and says a late answer costs a late "finished", and
 * the directory lookup has a cache of its own measured in seconds.
 */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** True when this process is in its terminal's foreground group, which `ps` marks with `+`. */
  foreground: boolean;
  /** The full command line, straight from the OS. */
  command: string;
}

export interface ProcessTable {
  /** Children of each pid, which is the shape both callers walk. */
  byParent: Map<number, ProcessRow[]>;
}

const TTL_MS = 250;
let table: ProcessTable | null = null;
let takenAt = 0;
let sweeping: Promise<ProcessTable | null> | null = null;

export async function processTable(): Promise<ProcessTable | null> {
  if (table && Date.now() - takenAt < TTL_MS) return table;
  sweeping ??= (async () => {
    try {
      const out = await run('/bin/ps', ['-o', 'pid=,ppid=,stat=,args=', '-ax']);
      if (!out) return null;
      const byParent = new Map<number, ProcessRow[]>();
      for (const line of out.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!match?.[1] || !match[2] || !match[3]) continue;
        const row: ProcessRow = {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          foreground: match[3].includes('+'),
          command: (match[4] ?? '').trim(),
        };
        const siblings = byParent.get(row.ppid);
        if (siblings) siblings.push(row);
        else byParent.set(row.ppid, [row]);
      }
      table = { byParent };
      takenAt = Date.now();
      return table;
    } finally {
      sweeping = null;
    }
  })();
  return await sweeping;
}

/** Forget the sweep, so a test that changes what is running is not answered from before it. */
export function forgetProcessTable(): void {
  table = null;
  takenAt = 0;
}

function run(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}
