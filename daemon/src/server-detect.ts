import { execFile } from 'node:child_process';
import { basename } from 'node:path';
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

/** A loopback listener that is not one of this product's sessions. */
export interface OtherListener {
  port: number;
  /** The program holding it, for a person deciding whether a row is theirs. */
  program: string;
  pid: number;
}

/**
 * Every loopback port on the machine, and what is holding it.
 *
 * The same `lsof` the session attribution already runs. It has never been filtered by pid: the
 * whole machine's listening sockets are fetched and everything not under a session is discarded,
 * so answering this costs the walk and nothing else.
 *
 * Loopback only, deliberately. A port bound to every interface is either a system service or
 * something a person configured on purpose, and neither belongs on a start screen. Above 1024 for
 * the same reason.
 *
 * Nothing is excluded by name here. What to hide is a question about what a person is looking at,
 * which the page knows and this does not, so it is answered there.
 */
export async function loopbackListeners(): Promise<OtherListener[]> {
  const lsof = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  if (!lsof) return [];

  const found = new Map<number, OtherListener>();
  let pid: number | null = null;
  let program = '';
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      program = '';
    } else if (line.startsWith('c')) {
      program = line.slice(1);
    } else if (line.startsWith('n') && pid !== null) {
      const address = line.slice(1);
      const loopback = address.startsWith('127.0.0.1:') || address.startsWith('[::1]:');
      if (!loopback) continue;
      const port = Number(/:(\d+)$/.exec(address)?.[1]);
      if (!Number.isFinite(port) || port <= 1024) continue;
      // One row per port. The same server often listens on both stacks.
      if (!found.has(port)) found.set(port, { port, program: basename(program), pid });
    }
  }

  const listeners = [...found.values()].sort((a, b) => a.port - b.port);
  debug('servers.loopback', { count: listeners.length });
  return listeners;
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
