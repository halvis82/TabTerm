import { describe, expect, it } from 'vitest';
import {
  clampPolicy,
  decide,
  DEFAULT_NOTIFY_POLICY,
  isAFailureWorthSaying,
  humanDuration,
  MAX_THRESHOLD_MS,
  MIN_THRESHOLD_MS,
} from './notify-policy.js';

const policy = DEFAULT_NOTIFY_POLICY;

describe('notification policy', () => {
  it('says nothing about a quick command', () => {
    expect(decide({ kind: 'command', command: 'ls', durationMs: 40, exitCode: 0 }, policy)).toBe(
      null,
    );
  });

  it('says nothing about a command that failed instantly', () => {
    // A typo, not an event. Notifying about these is how people turn notifications off.
    expect(decide({ kind: 'command', command: 'gti', durationMs: 30, exitCode: 127 }, policy)).toBe(
      null,
    );
  });

  it('names the command that finished', () => {
    const out = decide(
      { kind: 'command', command: 'npm test', durationMs: 95_000, exitCode: 0 },
      policy,
      '~/TabTerm',
    );
    expect(out?.title).toBe('Finished: npm test');
    expect(out?.body).toBe('Took 1m 35s in ~/TabTerm');
    expect(out?.priority).toBe('important');
  });

  it('raises a long failure to critical', () => {
    const out = decide(
      { kind: 'command', command: 'npm test', durationMs: 95_000, exitCode: 1 },
      policy,
    );
    expect(out?.priority).toBe('critical');
    expect(out?.body).toContain('Exit 1');
  });

  it('reports an agent turn, which no command boundary would see', () => {
    // The shell command is `claude` and it runs for an hour, so command-end fires when the
    // agent CLI is quit. The turn is the thing that actually finished.
    const out = decide({ kind: 'agent-turn', durationMs: 240_000 }, policy, 'eeg-analysis');
    expect(out?.title).toBe('Agent finished');
    expect(out?.body).toBe('Took 4m in eeg-analysis');
  });

  it('honors each switch independently', () => {
    const noCommands = { ...policy, commands: false };
    expect(
      decide({ kind: 'command', command: 'npm test', durationMs: 90_000, exitCode: 0 }, noCommands),
    ).toBe(null);
    expect(decide({ kind: 'agent-turn', durationMs: 90_000 }, noCommands)).not.toBe(null);

    const noAgents = { ...policy, agentTurns: false };
    expect(decide({ kind: 'agent-turn', durationMs: 90_000 }, noAgents)).toBe(null);
  });

  it('goes quiet entirely when disabled', () => {
    const off = { ...policy, enabled: false };
    expect(decide({ kind: 'agent-turn', durationMs: 600_000 }, off)).toBe(null);
  });
});

describe('threshold clamping', () => {
  it('refuses a threshold that would notify about ls', () => {
    expect(clampPolicy({ thresholdMs: 5 }).thresholdMs).toBe(MIN_THRESHOLD_MS);
  });

  it('refuses one that would notify about nothing', () => {
    expect(clampPolicy({ thresholdMs: 99_000_000 }).thresholdMs).toBe(MAX_THRESHOLD_MS);
  });

  it('falls back to the default for a value that is not a number', () => {
    expect(clampPolicy({ thresholdMs: Number.NaN }).thresholdMs).toBe(policy.thresholdMs);
    expect(clampPolicy(undefined)).toEqual(policy);
  });
});

describe('durations', () => {
  it('reads the way a person would say it', () => {
    expect(humanDuration(800)).toBe('800ms');
    expect(humanDuration(45_000)).toBe('45s');
    expect(humanDuration(120_000)).toBe('2m');
    expect(humanDuration(95_000)).toBe('1m 35s');
  });
});

/**
 * The notification he was actually getting, for work he had not started.
 *
 * "i keep getting these tabterm chrome notifications saying process failed with exit code 1. is
 * that you running something?" It was not. It was TabTerm reaping its own unused sessions, twelve
 * times in one day, and calling each one a failed process.
 */
describe('a process that ended, and whether that is worth saying', () => {
  const on = { ...DEFAULT_NOTIFY_POLICY };

  it('says nothing about a session TabTerm ended itself', () => {
    // The reaper sends a hangup and the shell exits 1. Nothing failed, and nothing of the
    // user's was involved. Every cause counts, not just the one the user asked for.
    for (const endedBy of [
      'expired-after-pane-close',
      'expired-after-tab-close',
      'user-kill',
      'user-closed-pane',
      'user-replaced-pane',
      'user-reset',
    ]) {
      expect(isAFailureWorthSaying({ exitCode: 1, endedBy }, on)).toBe(false);
    }
  });

  it('still says it when a process failed on its own', () => {
    // The case the notification exists for: a hidden tab whose build died, found much later.
    expect(isAFailureWorthSaying({ exitCode: 1 }, on)).toBe(true);
    expect(isAFailureWorthSaying({ exitCode: 127 }, on)).toBe(true);
  });

  it('says nothing about a clean exit', () => {
    expect(isAFailureWorthSaying({ exitCode: 0 }, on)).toBe(false);
    expect(isAFailureWorthSaying({}, on)).toBe(false);
  });

  it('and nothing at all when notifications are off', () => {
    // This one went out regardless of the policy, which is how a setting stops being believed.
    const off = { ...DEFAULT_NOTIFY_POLICY, enabled: false };
    expect(isAFailureWorthSaying({ exitCode: 1 }, off)).toBe(false);
  });
});
