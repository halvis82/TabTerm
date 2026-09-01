import { describe, expect, it } from 'vitest';
import { CommandTracker } from './command-tracker.js';
import { isNoise } from './foreground.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake `ps`, so these tests describe the rules rather than the machine they run on. */
function tracker(sequence: ({ pid: number; command: string } | null)[]) {
  const starts: { command: string }[] = [];
  const ends: { command: string; durationMs: number }[] = [];
  let calls = 0;
  const t = new CommandTracker(
    {
      onStart: (_id, command) => starts.push({ command }),
      onEnd: (_id, command, durationMs) => ends.push({ command, durationMs }),
    },
    () => Promise.resolve(sequence[Math.min(calls++, sequence.length - 1)] ?? null),
  );
  t.add('s1', 4242);
  return { t, starts, ends, probes: () => calls };
}

describe('detecting a command without shell integration', () => {
  it('reports a command that started, with its full line', async () => {
    const { t, starts } = tracker([{ pid: 10, command: 'npm run build' }]);
    t.onInput('s1', 'npm run build\r');
    await sleep(400);
    expect(starts).toEqual([{ command: 'npm run build' }]);
  });

  it('reports it finishing, with a duration', async () => {
    const { t, starts, ends } = tracker([
      { pid: 10, command: 'sleep 1' },
      null, // gone by the next check
    ]);
    t.onInput('s1', 'sleep 1\r');
    await sleep(1600);
    expect(starts).toHaveLength(1);
    expect(ends[0]?.command).toBe('sleep 1');
    expect(ends[0]?.durationMs).toBeGreaterThan(0);
  });

  it('does nothing until Enter is pressed', async () => {
    const { t, probes } = tracker([{ pid: 10, command: 'anything' }]);
    t.onInput('s1', 'npm run bui');
    await sleep(400);
    // Typing is editing a line that has not been submitted. Checking on every keystroke would
    // be a `ps` per character.
    expect(probes()).toBe(0);
  });

  it('reports nothing when Enter was pressed on an empty prompt', async () => {
    const { t, starts } = tracker([null]);
    t.onInput('s1', '\r');
    await sleep(400);
    expect(starts).toEqual([]);
  });

  it('ignores helpers a prompt runs for itself', async () => {
    // A prompt that shells out to decorate itself would otherwise look like a command on every
    // single Enter.
    const { t, starts } = tracker([{ pid: 10, command: '/usr/bin/tput colors' }]);
    t.onInput('s1', '\r');
    await sleep(400);
    expect(starts).toEqual([]);
  });

  it('picks up the next command in a chain that changed between checks', async () => {
    const { t, starts, ends } = tracker([
      { pid: 10, command: 'npm run build' },
      { pid: 11, command: 'npm test' },
      null,
    ]);
    t.onInput('s1', 'npm run build && npm test\r');
    await sleep(2600);
    expect(starts.map((s) => s.command)).toEqual(['npm run build', 'npm test']);
    expect(ends.map((e) => e.command)).toEqual(['npm run build', 'npm test']);
  });

  it('does not start a second command while one is running', async () => {
    const { t, starts } = tracker([{ pid: 10, command: 'vim notes' }]);
    t.onInput('s1', 'vim notes\r');
    await sleep(400);
    // Typing inside vim produces plenty of carriage returns, and none of them are new commands.
    t.onInput('s1', '\r');
    t.onInput('s1', '\r');
    await sleep(400);
    expect(starts).toHaveLength(1);
  });
});

describe('deferring to real shell integration', () => {
  it('stops probing once a session reports an OSC 133 mark', async () => {
    // Two sources of truth would double every history entry.
    const { t, starts, probes } = tracker([{ pid: 10, command: 'npm test' }]);
    t.markIntegrated('s1');
    t.onInput('s1', 'npm test\r');
    await sleep(400);
    expect(probes()).toBe(0);
    expect(starts).toEqual([]);
    expect(t.usesIntegration('s1')).toBe(true);
  });

  it('abandons a command it was already tracking rather than finishing it', async () => {
    const { t, ends } = tracker([{ pid: 10, command: 'npm test' }, null]);
    t.onInput('s1', 'npm test\r');
    await sleep(400);
    expect(t.isRunning('s1')).toBe(true);

    t.markIntegrated('s1');
    await sleep(1400);
    // The integration will report it properly. Reporting it here too would duplicate it.
    expect(ends).toEqual([]);
    expect(t.isRunning('s1')).toBe(false);
  });
});

describe('costs nothing when nothing is happening', () => {
  it('runs no probe at all for an idle session', async () => {
    const { probes } = tracker([null]);
    await sleep(1400);
    expect(probes()).toBe(0);
  });

  it('stops probing once a command has finished', async () => {
    const { t, probes } = tracker([{ pid: 10, command: 'ls -la' }, null]);
    t.onInput('s1', 'ls -la\r');
    await sleep(1600);
    const after = probes();
    await sleep(1600);
    expect(probes()).toBe(after);
  });

  it('forgets a session that went away', async () => {
    const { t, probes } = tracker([{ pid: 10, command: 'x' }]);
    t.onInput('s1', '\r');
    t.remove('s1');
    await sleep(500);
    expect(probes()).toBe(0);
  });
});

describe('noise filtering', () => {
  it('recognizes shell helpers by name, with or without a path', () => {
    expect(isNoise('tput colors')).toBe(true);
    expect(isNoise('/usr/bin/stty -a')).toBe(true);
    expect(isNoise('npm test')).toBe(false);
    expect(isNoise('')).toBe(false);
  });
});
