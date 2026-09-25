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
 *
 * **Two clocks, because a closed lid is not a stall.** The wall clock keeps time while a machine
 * sleeps and the monotonic clock does not, so a timer due in half a second that fires sixteen
 * minutes later by the wall clock and half a second later by the monotonic one describes a laptop
 * that was shut, not a process that was blocked. The first eleven records this produced were all
 * that, up to sixteen minutes each, which is exactly the noise that would bury the thing it was
 * built to catch. Lateness is measured on the monotonic clock; the gap between the two is the
 * sleep, and it is worth saying once because it explains the silences in this log and a reap that
 * ran late.
 */
export interface LoopLagOptions {
  /** How often to look. Frequent enough to catch a short stall, cheap enough to ignore. */
  everyMs?: number;
  /** Lateness worth saying out loud. Below this is ordinary scheduling. */
  sayAfterMs?: number;
  /** Called with how late the loop was, in milliseconds, measured against a clock sleep stops. */
  onStall: (lateBy: number) => void;
  /** Called when the machine itself was away, which is not this process being slow. */
  onSlept?: (forMs: number) => void;
  /** How much of a jump between the clocks is worth calling sleep rather than rounding. */
  sleepAfterMs?: number;
  /** Injectable for tests, which must not wait in real time. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  /** The wall clock, which keeps running while a machine sleeps. */
  now?: () => number;
  /** The monotonic clock, which does not. */
  monotonic?: () => number;
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
  const sleepAfterMs = opts.sleepAfterMs ?? 5000;
  const now = opts.now ?? (() => Date.now());
  const monotonic = opts.monotonic ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let stopped = false;

  /**
   * Arm the next look, remembering when it is due **now** rather than when it fires.
   *
   * Reading the clocks inside the callback is reading them after the wait, so the answer is
   * always zero and the whole thing measures nothing. It passed its own checks that way, because
   * a fake clock advanced by a test is late by exactly nothing too.
   */
  const arm = (): void => {
    const dueWall = now() + everyMs;
    const dueSteady = monotonic() + everyMs;
    setTimer(() => {
      tick(dueWall, dueSteady);
    }, everyMs).unref?.();
  };

  const tick = (dueWall: number, dueSteady: number): void => {
    if (stopped) return;
    const blocked = lateness(dueSteady, monotonic());
    // What the wall clock counted beyond that is time this machine was not running at all.
    const away = lateness(dueWall, now()) - blocked;
    if (blocked >= sayAfterMs) opts.onStall(blocked);
    if (away >= sleepAfterMs) opts.onSlept?.(away);
    arm();
  };

  arm();
  return () => {
    stopped = true;
  };
}
