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
 *
 * **And processor time beside the lateness, because late says nothing about why.** A loop blocked
 * on its own work burns processor for the whole time it is late. A process that was simply not
 * scheduled, because four browsers and a test run are on the same machine, burns almost none and
 * is late by exactly as much. The timer cannot tell them apart and only one of them is a defect
 * in this program, so the number that separates them is recorded with it.
 */
export interface LoopLagOptions {
  /** How often to look. Frequent enough to catch a short stall, cheap enough to ignore. */
  everyMs?: number;
  /** Lateness worth saying out loud. Below this is ordinary scheduling. */
  sayAfterMs?: number;
  /**
   * Called with how late the loop was, and how much processor time it used while being late.
   *
   * The second number is what makes the first one actionable. A loop blocked on its own work
   * burns processor for the whole time it is late; a process that was simply not scheduled,
   * because four browsers and a suite are on the same machine, burns almost none. Both look
   * identical from the timer alone, and only one of them is a defect in this program.
   */
  onStall: (lateBy: number, cpuMs: number) => void;
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
  /** Processor time used by this process, in microseconds. Injectable for tests. */
  cpu?: () => { user: number; system: number };
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
  const cpu = opts.cpu ?? (() => process.cpuUsage());
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
    const from = cpu();
    setTimer(() => {
      tick(dueWall, dueSteady, from);
    }, everyMs).unref?.();
  };

  const tick = (
    dueWall: number,
    dueSteady: number,
    from: { user: number; system: number },
  ): void => {
    if (stopped) return;
    const blocked = lateness(dueSteady, monotonic());
    // What the wall clock counted beyond that is time this machine was not running at all.
    const away = lateness(dueWall, now()) - blocked;
    const to = cpu();
    // Microseconds on the way in, milliseconds on the way out, which is the unit beside it.
    const used = Math.round((to.user - from.user + (to.system - from.system)) / 1000);
    if (blocked >= sayAfterMs) opts.onStall(blocked, Math.max(0, used - everyMs));
    if (away >= sleepAfterMs) opts.onSlept?.(away);
    arm();
  };

  arm();
  return () => {
    stopped = true;
  };
}
