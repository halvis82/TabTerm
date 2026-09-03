import { describe, expect, it } from 'vitest';
import { describeTime, formatAgo, formatDuration, isLongRunning } from './elapsed.js';

describe('duration formatting', () => {
  it('keeps short durations in seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(8_400)).toBe('8s');
    expect(formatDuration(59_999)).toBe('59s');
  });

  it('rolls into minutes, hours, and days', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });

  it('refuses nonsense rather than rendering it', () => {
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });

  it('says just now rather than 0s ago', () => {
    const now = 1_000_000;
    expect(formatAgo(now - 500, now)).toBe('just now');
    expect(formatAgo(now - 65_000, now)).toBe('1m 5s ago');
  });
});

describe('what a pane says about time', () => {
  const now = 10_000_000;

  it('shows a running command ticking, in preference to anything else', () => {
    expect(
      describeTime(
        { commandStartedAt: now - 42_000, sessionStartedAt: now - 900_000, lastDurationMs: 5 },
        now,
      ),
    ).toBe('running 42s');
  });

  it('shows how the last command went once it finishes', () => {
    expect(
      describeTime({ lastDurationMs: 15_200, lastExitCode: 0, lastFinishedAt: now - 5_000 }, now),
    ).toBe('took 15s · 5s ago');
  });

  it('calls out a failure with its exit code', () => {
    expect(
      describeTime({ lastDurationMs: 2_000, lastExitCode: 1, lastFinishedAt: now - 1_000 }, now),
    ).toContain('exit 1');
  });

  it('falls back to how long the session has been open', () => {
    expect(describeTime({ sessionStartedAt: now - 3_600_000 }, now)).toBe('open 1h 0m');
  });

  it('says nothing about a session that just opened', () => {
    // Being told a terminal is four seconds old is noise, not information.
    expect(describeTime({ sessionStartedAt: now - 4_000 }, now)).toBe('');
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(describeTime({}, now)).toBe('');
  });
});

describe('what counts as long running', () => {
  const now = 1_000_000;

  it('ignores a command that finished before anyone looked away', () => {
    expect(isLongRunning(now - 3_000, 30_000, now)).toBe(false);
  });

  it('recognizes one worth mentioning', () => {
    expect(isLongRunning(now - 45_000, 30_000, now)).toBe(true);
  });

  it('honors a configured threshold', () => {
    expect(isLongRunning(now - 6_000, 5_000, now)).toBe(true);
  });
});

describe('how long the session has been open', () => {
  /**
   * The start screen says it and a terminal in use did not, so the moment you started working
   * the one number that puts the rest in context disappeared.
   */
  it('is shown beside what the last command did', () => {
    const said = describeTime(
      {
        lastDurationMs: 1200,
        lastFinishedAt: 10_000,
        sessionStartedAt: 0,
      },
      600_000,
    );
    expect(said).toContain('took');
    expect(said).toContain('open');
  });

  it('is left out while the session is still new', () => {
    // Nobody needs to be told a session is four seconds old.
    const said = describeTime(
      { lastDurationMs: 1200, lastFinishedAt: 3000, sessionStartedAt: 0 },
      4000,
    );
    expect(said).not.toContain('open');
  });

  it('is not shown while something is running, which is the more urgent number', () => {
    const said = describeTime({ commandStartedAt: 0, sessionStartedAt: 0 }, 600_000);
    expect(said).toContain('running');
    expect(said).not.toContain('open');
  });
});
