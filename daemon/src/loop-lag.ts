/**
 * Whether this process was able to answer when it was needed.
 *
 * Both processes on the path of a keystroke are single threaded: if either stops turning its loop,
 * every terminal it serves waits, and nothing in the product can tell afterwards that it happened.
 * A stall of a second was reported and then could not be reproduced on a quiet machine after five
 * hundred measurements, which is the worst shape a fault can have: real enough to be seen, rare
 * enough that looking for it finds nothing.
 *
 * So the next one writes itself down. A timer that should fire every `everyMs` is late by exactly
 * the time the loop spent elsewhere, which is the delay every other piece of work saw too.
 */
export interface LoopLagOptions {
  /** How often to look. Frequent enough to catch a short stall, cheap enough to ignore. */
  everyMs?: number;
  /** Lateness worth saying out loud. Below this is ordinary scheduling. */
  sayAfterMs?: number;
  /** Called with how late the loop was, in milliseconds. */
  onStall: (lateBy: number) => void;
  /** Injectable for tests, which must not wait in real time. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  now?: () => number;
}

/** How late a tick was, given when it was expected. Never negative: early is not lateness. */
export function lateness(expectedAt: number, actualAt: number): number {
  return Math.max(0, Math.round(actualAt - expectedAt));
}

/**
 * Watch this process's own event loop and report when it stops turning.
 *
 * Returns the way to stop watching, which matters only for tests: in the daemon it runs for the
 * life of the process and is unref'd, so it can never be the reason one stays alive.
 */
export function watchLoopLag(opts: LoopLagOptions): () => void {
  const everyMs = opts.everyMs ?? 500;
  const sayAfterMs = opts.sayAfterMs ?? 250;
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let stopped = false;

  const tick = (expectedAt: number): void => {
    if (stopped) return;
    const lateBy = lateness(expectedAt, now());
    if (lateBy >= sayAfterMs) opts.onStall(lateBy);
    const next = now() + everyMs;
    setTimer(() => tick(next), everyMs).unref?.();
  };

  const first = now() + everyMs;
  setTimer(() => tick(first), everyMs).unref?.();
  return () => {
    stopped = true;
  };
}
