import { execFile } from 'node:child_process';
import { debug } from './log.js';

/**
 * Which sessions are holding a listening socket.
 *
 * A shell that started a dev server must not be reaped because a tab closed, so the reap
 * policy needs to know. Asking the OS is the only reliable way: parsing terminal output for
 * "listening on 3000" would be exactly the screen-scraping the design forbids.
 *
 * Event driven rather than polled. This runs when a session detaches, which is the only moment
 * the answer changes anything. See docs/11-performance.md §6.
 */

/** pid of the session leader -> the first listening port found beneath it. */
export async function listeningPorts(pids: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (pids.length === 0) return out;

  const lsof = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  if (!lsof) return out;

  // lsof -F emits records prefixed by field type: p<pid>, then n<addr> lines for that process.
  const byPid = new Map<number, number>();
  let current: number | null = null;
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) {
      current = Number(line.slice(1));
    } else if (line.startsWith('n') && current !== null && !byPid.has(current)) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (Number.isFinite(port)) byPid.set(current, port);
    }
  }
  if (byPid.size === 0) return out;

  // A server is usually a grandchild of the shell, so walk the process tree to attribute it.
  const parents = await parentMap();
  for (const [listenerPid, port] of byPid) {
    let cursor: number | undefined = listenerPid;
    for (let depth = 0; depth < 12 && cursor !== undefined; depth++) {
      if (pids.includes(cursor)) {
        if (!out.has(cursor)) out.set(cursor, port);
        break;
      }
      cursor = parents.get(cursor);
    }
  }

  if (out.size > 0) debug('servers.detected', { count: out.size });
  return out;
}

async function parentMap(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const ps = await run('/bin/ps', ['-o', 'pid=,ppid=', '-ax']);
  if (!ps) return map;
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // lsof exits non-zero when it finds nothing, which is not an error here.
      resolve(stdout && stdout.length > 0 ? stdout : err ? null : stdout);
    });
  });
}
