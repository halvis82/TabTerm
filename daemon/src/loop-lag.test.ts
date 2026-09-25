import { describe, expect, it, vi } from 'vitest';
import { lateness, watchLoopLag } from './loop-lag.js';

describe('how late a tick was', () => {
  it('is the time past when it was due', () => {
    expect(lateness(1000, 1750)).toBe(750);
  });

  it('is nothing when it was on time or early', () => {
    // A timer firing a millisecond early is not the loop being fast; it is rounding.
    expect(lateness(1000, 1000)).toBe(0);
    expect(lateness(1000, 999)).toBe(0);
  });
});

describe('watching the loop', () => {
  /**
   * Two clocks and a timer queue that only move when a test says so.
   *
   * Two, because that is the whole point: the wall clock keeps time while a machine sleeps and
   * the monotonic one does not, and a laptop being shut must not read as a blocked process.
   */
  const fakeWorld = () => {
    let wall = 0;
    let steady = 0;
    let burned = 0;
    const queue: { at: number; fn: () => void }[] = [];
    return {
      now: () => wall,
      monotonic: () => steady,
      // Microseconds, the way the runtime reports them.
      cpu: () => ({ user: burned * 1000, system: 0 }),
      burn: (ms: number) => {
        burned += ms;
      },
      setTimer: (fn: () => void, ms: number) => {
        queue.push({ at: steady + ms, fn });
        return {};
      },
      /**
       * Move time on, running whatever was due. `busyMs` is the loop stuck on something, which
       * both clocks see; `sleptMs` is the machine away, which only the wall clock sees.
       */
      advance: (ms: number, busyMs = 0, sleptMs = 0) => {
        wall += ms;
        steady += ms;
        // Time passing is time this process had, whether or not it was blocked on anything.
        burned += ms;
        const due = queue.filter((t) => t.at <= steady);
        for (const t of due) queue.splice(queue.indexOf(t), 1);
        wall += busyMs + sleptMs;
        steady += busyMs;
        burned += busyMs;
        for (const t of due) t.fn();
      },
    };
  };

  it('says nothing while the loop is turning', () => {
    const world = fakeWorld();
    const onStall = vi.fn();
    watchLoopLag({
      onStall,
      now: world.now,
      monotonic: world.monotonic,
      cpu: world.cpu,
      setTimer: world.setTimer,
      everyMs: 500,
    });
    for (let i = 0; i < 5; i++) world.advance(500);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('reports how long the loop was blocked, and that it was working', () => {
    const world = fakeWorld();
    const onStall = vi.fn();
    watchLoopLag({
      onStall,
      now: world.now,
      monotonic: world.monotonic,
      cpu: world.cpu,
      setTimer: world.setTimer,
      everyMs: 500,
      sayAfterMs: 250,
    });
    world.advance(500, 1200);
    expect(onStall).toHaveBeenCalledWith(1200, 1200);
  });

  /**
   * The same lateness, with the processor idle, which is a different fault entirely.
   *
   * A process that was not scheduled is late by exactly as much as one blocked on its own work,
   * and the timer cannot tell them apart. Four browsers and a test run on one machine produce
   * the first; only the second is anything to fix here.
   */
  it('says when it was late without doing anything, which is the machine and not this', () => {
    const world = fakeWorld();
    const onStall = vi.fn();
    watchLoopLag({
      onStall,
      now: world.now,
      monotonic: world.monotonic,
      cpu: () => ({ user: 0, system: 0 }),
      setTimer: world.setTimer,
      everyMs: 500,
      sayAfterMs: 250,
    });
    world.advance(500, 1200);
    expect(onStall).toHaveBeenCalledWith(1200, 0);
  });

  it('ignores lateness too small to matter', () => {
    // Ordinary scheduling on a busy machine, which is not news and would be all the log said.
    const world = fakeWorld();
    const onStall = vi.fn();
    watchLoopLag({
      onStall,
      now: world.now,
      monotonic: world.monotonic,
      cpu: world.cpu,
      setTimer: world.setTimer,
      everyMs: 500,
      sayAfterMs: 250,
    });
    world.advance(500, 40);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('keeps watching after a stall rather than reporting one and stopping', () => {
    const world = fakeWorld();
    const onStall = vi.fn();
    watchLoopLag({
      onStall,
      now: world.now,
      monotonic: world.monotonic,
      cpu: world.cpu,
      setTimer: world.setTimer,
      everyMs: 500,
      sayAfterMs: 250,
    });
    world.advance(500, 900);
    world.advance(500, 800);
    expect(onStall).toHaveBeenCalledTimes(2);
  });

  it('calls a closed lid sleep rather than a stall', () => {
    /*
     * The first eleven records this produced on a real machine were all this: up to sixteen
     * minutes of wall clock with a loop that never missed a beat. That is the noise that would
     * bury the thing this exists to catch.
     */
    const world = fakeWorld();
    const onStall = vi.fn();
    const onSlept = vi.fn();
    watchLoopLag({
      onStall,
      onSlept,
      now: world.now,
      monotonic: world.monotonic,
      cpu: world.cpu,
      setTimer: world.setTimer,
      everyMs: 500,
      sayAfterMs: 250,
    });
    world.advance(500, 0, 966_000);
    expect(onStall).not.toHaveBeenCalled();
    expect(onSlept).toHaveBeenCalledWith(966_000);
  });

  it('still catches a stall that happens across a sleep', () => {
    // Both at once: the machine was away and the loop was also blocked when it came back.
    const world = fakeWorld();
    const onStall = vi.fn();
    const onSlept = vi.fn();
    watchLoopLag({
      onStall,
      onSlept,
      now: world.now,
      monotonic: world.monotonic,
      cpu: world.cpu,
      setTimer: world.setTimer,
      everyMs: 500,
      sayAfterMs: 250,
    });
    world.advance(500, 900, 60_000);
    expect(onStall).toHaveBeenCalledWith(900, 900);
    expect(onSlept).toHaveBeenCalledWith(60_000);
  });

  it('stops when it is told to', () => {
    const world = fakeWorld();
    const onStall = vi.fn();
    const stop = watchLoopLag({
      onStall,
      now: world.now,
      monotonic: world.monotonic,
      cpu: world.cpu,
      setTimer: world.setTimer,
      everyMs: 500,
    });
    stop();
    world.advance(500, 5000);
    expect(onStall).not.toHaveBeenCalled();
  });
});
