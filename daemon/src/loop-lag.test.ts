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
  /** A clock and a timer queue that only move when a test says so. */
  const fakeWorld = () => {
    let clock = 0;
    const queue: { at: number; fn: () => void }[] = [];
    return {
      now: () => clock,
      setTimer: (fn: () => void, ms: number) => {
        queue.push({ at: clock + ms, fn });
        return {};
      },
      /** Move time on, running whatever was due, and pretending the loop was busy for `busyMs`. */
      advance: (ms: number, busyMs = 0) => {
        clock += ms;
        const due = queue.filter((t) => t.at <= clock);
        for (const t of due) queue.splice(queue.indexOf(t), 1);
        clock += busyMs;
        for (const t of due) t.fn();
      },
    };
  };

  it('says nothing while the loop is turning', () => {
    const world = fakeWorld();
    const onStall = vi.fn();
    watchLoopLag({ onStall, now: world.now, setTimer: world.setTimer, everyMs: 500 });
    for (let i = 0; i < 5; i++) world.advance(500);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('reports how long the loop was blocked', () => {
    const world = fakeWorld();
    const onStall = vi.fn();
    watchLoopLag({
      onStall,
      now: world.now,
      setTimer: world.setTimer,
      everyMs: 500,
      sayAfterMs: 250,
    });
    world.advance(500, 1200);
    expect(onStall).toHaveBeenCalledWith(1200);
  });

  it('ignores lateness too small to matter', () => {
    // Ordinary scheduling on a busy machine, which is not news and would be all the log said.
    const world = fakeWorld();
    const onStall = vi.fn();
    watchLoopLag({
      onStall,
      now: world.now,
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
      setTimer: world.setTimer,
      everyMs: 500,
      sayAfterMs: 250,
    });
    world.advance(500, 900);
    world.advance(500, 800);
    expect(onStall).toHaveBeenCalledTimes(2);
  });

  it('stops when it is told to', () => {
    const world = fakeWorld();
    const onStall = vi.fn();
    const stop = watchLoopLag({ onStall, now: world.now, setTimer: world.setTimer, everyMs: 500 });
    stop();
    world.advance(500, 5000);
    expect(onStall).not.toHaveBeenCalled();
  });
});
