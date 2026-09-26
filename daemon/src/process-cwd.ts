import { execFile } from 'node:child_process';
import { processTable } from './process-table.js';
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
/**
 * The directories of everything asked about in the same moment, in one question.
 *
 * `lsof` was run once per session, so a start screen with seven terminals on it forked seven of
 * them at once and waited for all seven. It takes a list: one call answers for all of them, and
 * the `-Fpn` output says which path belongs to which process, so nothing is guessed.
 *
 * Batched by waiting a turn of the event loop rather than a length of time. Everything that asks
 * together already asks in the same `Promise.all`, which is one turn, so the wait is nothing and
 * the saving is the difference between one fork and seven.
 */
let waiting: Map<number, ((cwd: string | null) => void)[]> | null = null;

function lookup(pid: number): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    if (waiting) {
      const held = waiting.get(pid);
      if (held) held.push(resolve);
      else waiting.set(pid, [resolve]);
      return;
    }
    waiting = new Map([[pid, [resolve]]]);
    setTimeout(() => {
      const batch = waiting ?? new Map<number, ((cwd: string | null) => void)[]>();
      waiting = null;
      void resolveBatch(batch);
    }, 0);
  });
}

async function resolveBatch(batch: Map<number, ((cwd: string | null) => void)[]>): Promise<void> {
  const answer = (pid: number, cwd: string | null): void => {
    for (const settle of batch.get(pid) ?? []) settle(cwd);
  };
  try {
    // Where to actually look, per session: the deepest descendant, off the shared sweep.
    const targets = new Map<number, number[]>();
    await Promise.all(
      [...batch.keys()].map(async (pid) => {
        const target = (await deepestChild(pid)) ?? pid;
        const asking = targets.get(target);
        if (asking) asking.push(pid);
        else targets.set(target, [pid]);
      }),
    );

    const out = await run('/usr/sbin/lsof', [
      '-a',
      '-d',
      'cwd',
      '-p',
      [...targets.keys()].join(','),
      '-Fpn',
    ]);
    const found = new Map<number, string>();
    if (out) {
      let current = 0;
      for (const line of out.split('\n')) {
        if (line.startsWith('p')) {
          current = Number(line.slice(1));
          continue;
        }
        if (!line.startsWith('n/') || current === 0) continue;
        const path = line.slice(1);
        // `n/` alone means lsof could not read it, which is not a directory.
        if (path.length > 1 && !found.has(current)) found.set(current, path);
      }
    }

    for (const [target, asking] of targets) {
      const cwd = found.get(target) ?? null;
      for (const pid of asking) answer(pid, cwd);
    }
    // Anything the sweep never named still has to be answered, or its caller waits for ever.
    for (const pid of batch.keys()) answer(pid, null);
  } catch {
    for (const pid of batch.keys()) answer(pid, null);
  }
}

async function deepestChild(pid: number): Promise<number | null> {
  const table = await processTable();
  if (!table) return null;

  let current = pid;
  for (let depth = 0; depth < 8; depth++) {
    const kids = table.byParent.get(current);
    if (!kids || kids.length === 0) break;
    // Most recently started child, which is the one the user is interacting with.
    current = Math.max(...kids.map((row) => row.pid));
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
