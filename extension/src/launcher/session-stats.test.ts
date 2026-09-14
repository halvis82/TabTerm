import { describe, expect, it } from 'vitest';
import { SessionStats, formatDuration, formatTime } from './session-stats.js';

describe('recording what a session did', () => {
  it('counts commands and how long they took', () => {
    const stats = new SessionStats();
    stats.begin('a', 'npm test', 1000);
    stats.end('a', 4000, 0);
    stats.begin('b', 'git status', 2000);
    stats.end('b', 200, 0);

    const summary = stats.summarize();
    expect(summary.total).toBe(2);
    expect(summary.totalMs).toBe(4200);
    expect(summary.failed).toBe(0);
  });

  it('counts a failure', () => {
    const stats = new SessionStats();
    stats.begin('a', 'make', 0);
    stats.end('a', 100, 1);
    expect(stats.summarize().failed).toBe(1);
  });

  it('reports what is still running', () => {
    const stats = new SessionStats();
    stats.begin('a', 'npm run dev', 0);
    expect(stats.summarize().running).toBe(1);
    expect(stats.records[0]?.durationMs).toBeUndefined();
  });

  it('uses the median, not the mean', () => {
    // One npm install should not describe a session of quick commands, which is exactly what an
    // average would do.
    const stats = new SessionStats();
    stats.begin('a', 'a', 0);
    stats.end('a', 100);
    stats.begin('b', 'b', 0);
    stats.end('b', 100);
    stats.begin('c', 'c', 0);
    stats.end('c', 600_000);
    expect(stats.summarize().medianMs).toBe(100);
  });

  it('names the longest command', () => {
    const stats = new SessionStats();
    stats.begin('a', 'quick', 0);
    stats.end('a', 50);
    stats.begin('b', 'slow', 0);
    stats.end('b', 9000);
    expect(stats.summarize().longest?.command).toBe('slow');
  });

  it('matches an ending to its own start, not to the same text', () => {
    // The same command run twice is two things. Matching on text would give the second run's
    // timing to the first.
    const stats = new SessionStats();
    stats.begin('first', 'npm test', 0);
    stats.begin('second', 'npm test', 0);
    stats.end('second', 500);
    const records = stats.records;
    expect(records.filter((r) => r.durationMs === 500)).toHaveLength(1);
    expect(stats.summarize().running).toBe(1);
  });

  it('ignores an ending with no matching start', () => {
    const stats = new SessionStats();
    expect(() => stats.end('nothing', 100)).not.toThrow();
    expect(stats.summarize().total).toBe(0);
  });

  it('lists newest first', () => {
    const stats = new SessionStats();
    stats.begin('a', 'older', 0);
    stats.begin('b', 'newer', 0);
    expect(stats.records[0]?.command).toBe('newer');
  });

  it('stays bounded over a long session', () => {
    const stats = new SessionStats();
    for (let i = 0; i < 900; i++) stats.begin(String(i), `command ${String(i)}`, 0);
    expect(stats.records.length).toBeLessThanOrEqual(500);
  });
});

describe('formatting', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('says a command is still running rather than showing a zero', () => {
    expect(formatDuration(undefined)).toBe('running');
  });

  it('shows a wall-clock time, because when is half the point', () => {
    expect(formatTime(new Date(2026, 0, 1, 9, 5, 3).getTime())).toBe('09:05:03');
  });
});

/**
 * Turns, which no command boundary can see.
 *
 * A pane running an agent is one long command, so everything counted from command boundaries says
 * the same thing about it all day: one command, still running. What happened in that pane is a
 * number of answers and how long each took.
 */
describe('what an agent was asked', () => {
  it('says nothing at all before a turn has finished', () => {
    const stats = new SessionStats();
    expect(stats.turns()).toEqual({
      count: 0,
      totalMs: 0,
      longestMs: 0,
      lastMs: null,
      lastEndedAt: null,
    });
  });

  it('counts finished turns and keeps the longest and the last', () => {
    const stats = new SessionStats();
    stats.turnFinished(30_000, 1_000);
    stats.turnFinished(90_000, 2_000);
    stats.turnFinished(10_000, 3_000);
    const turns = stats.turns();
    expect(turns.count).toBe(3);
    expect(turns.totalMs).toBe(130_000);
    expect(turns.longestMs).toBe(90_000);
    expect(turns.lastMs).toBe(10_000);
    expect(turns.lastEndedAt).toBe(3_000);
  });

  it('refuses a duration that is not one, rather than counting a turn of NaN', () => {
    const stats = new SessionStats();
    stats.turnFinished(Number.NaN);
    stats.turnFinished(-5);
    expect(stats.turns().count).toBe(0);
  });
});
