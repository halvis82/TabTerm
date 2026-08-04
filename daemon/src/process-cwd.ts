import { execFile } from 'node:child_process';
import { debug } from './log.js';

/**
 * Ask the OS where a session's shell actually is.
 *
 * OSC 7 is the fast path, but it only works if the user sourced the shell integration, and
 * most people will not have. Without a real directory, every relative path in the terminal
 * resolves against wherever the session started, so `src/main.ts` is never clickable after the
 * first `cd`.
 *
 * The kernel already knows. Asking it costs about 20 ms and needs no shell setup at all, which
 * makes clickable paths work out of the box. See docs/08-shell-integration.md.
 */

const CACHE_MS = 750;
const cache = new Map<number, { cwd: string; at: number }>();

export async function processCwd(pid: number): Promise<string | null> {
  const hit = cache.get(pid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cwd;

  const cwd = await lookup(pid);
  if (cwd) cache.set(pid, { cwd, at: Date.now() });
  return cwd;
}

export function forgetCwd(pid: number): void {
  cache.delete(pid);
}

/**
 * The shell is the session leader, but after `cd` in a subshell or while a child is in the
 * foreground, the interesting directory belongs to the deepest descendant. Walk to it.
 */
async function lookup(pid: number): Promise<string | null> {
  const target = (await deepestChild(pid)) ?? pid;
  const out = await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', String(target), '-Fn']);
  if (!out) return null;
  for (const line of out.split('\n')) {
    if (line.startsWith('n/')) {
      const path = line.slice(1);
      // `n/` alone means lsof could not read it, which is not a directory.
      if (path.length > 1) return path;
    }
  }
  return null;
}

async function deepestChild(pid: number): Promise<number | null> {
  const out = await run('/bin/ps', ['-o', 'pid=,ppid=', '-ax']);
  if (!out) return null;

  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const child = Number(m[1]);
    const parent = Number(m[2]);
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  }

  let current = pid;
  for (let depth = 0; depth < 8; depth++) {
    const kids = children.get(current);
    if (!kids || kids.length === 0) break;
    // Most recently started child, which is the one the user is interacting with.
    current = Math.max(...kids);
  }
  return current === pid ? null : current;
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        debug('cwd.lookup.failed', { file, error: err.message });
        resolve(null);
      } else {
        resolve(stdout);
      }
    });
  });
}
