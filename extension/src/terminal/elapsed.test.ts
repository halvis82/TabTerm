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
    ).toBe('running 42s · alive 15m 0s');
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

  it('falls back to how long the session has been alive', () => {
    expect(describeTime({ sessionStartedAt: now - 3_600_000 }, now)).toBe('alive 1h 0m');
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

describe('how long the session has been alive', () => {
  /**
   * Asked for "in addition to what is already there", so it ends every line rather than being
   * one of the alternatives, and it counts from the session rather than from the tab.
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
    expect(said).toBe('took 1s · 9m 50s ago · alive 10m 0s');
  });

  it('is left out while the session is still new', () => {
    // Nobody needs to be told a session is four seconds old.
    const said = describeTime(
      { lastDurationMs: 1200, lastFinishedAt: 3000, sessionStartedAt: 0 },
      4000,
    );
    expect(said).not.toContain('alive');
  });

  it('is shown while something is running too, after the running time', () => {
    const said = describeTime({ commandStartedAt: 300_000, sessionStartedAt: 0 }, 600_000);
    expect(said).toBe('running 5m 0s · alive 10m 0s');
  });

  it('is shown in an agent pane, through a turn and after it', () => {
    expect(
      describeTime(
        { agentTurnStartedAt: 540_000, agentState: 'working', sessionStartedAt: 0 },
        600_000,
      ),
    ).toBe('answering 1m 0s · alive 10m 0s');
    expect(
      describeTime({ lastTurnMs: 30_000, lastTurnEndedAt: 590_000, sessionStartedAt: 0 }, 600_000),
    ).toBe('answered in 30s · 10s ago · alive 10m 0s');
  });
});

/**
 * A pane running an agent answers the question that pane is about.
 *
 * Every other line in it is about the wrong thing: the command that is running is the agent CLI,
 * which started with the session, so the strip said "running 47m" about a process nobody is
 * waiting on. It was the reported uselessness of this line, and the fix is not a better format.
 */
describe('a pane running an agent', () => {
  const at = 1_000_000;

  it('says how long the answer has taken, not how long the CLI has been up', () => {
    expect(
      describeTime(
        {
          sessionStartedAt: at - 3_600_000,
          commandStartedAt: at - 3_600_000,
          agentTurnStartedAt: at - 74_000,
          agentState: 'working',
        },
        at,
      ),
    ).toBe('answering 1m 14s · alive 1h 0m');
  });

  it('says a turn blocked on a person is blocked on them', () => {
    // The clock is still running and the number is still true. What somebody glancing at the
    // pane needs to know is that the thing holding it up is them.
    expect(describeTime({ agentTurnStartedAt: at - 30_000, agentState: 'waiting' }, at)).toBe(
      'waiting for you · 30s',
    );
    expect(describeTime({ agentTurnStartedAt: at - 30_000, agentState: 'approval' }, at)).toBe(
      'needs approval · 30s',
    );
  });

  it('says what the last answer cost once it is over', () => {
    expect(
      describeTime({ lastTurnMs: 95_000, lastTurnEndedAt: at - 10_000, agentState: 'idle' }, at),
    ).toBe('answered in 1m 35s · 10s ago');
  });

  it('goes back to the command line when there is no agent in it', () => {
    expect(describeTime({ commandStartedAt: at - 5_000 }, at)).toBe('running 5s');
  });
});
