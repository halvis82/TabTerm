import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandTracker } from './command-tracker.js';
import { DEFAULTS, type Config } from './config.js';
import { foregroundOf } from './foreground.js';
import { initLog } from './log.js';
import { SessionManager } from './session-manager.js';

/**
 * The fallback against a real shell, with no integration sourced.
 *
 * This is the case the feature exists for, so it is the case that has to be tested for real.
 * A fake `ps` proves the rules; only a real one proves the daemon can actually see a command.
 */
const config: Config = { ...DEFAULTS };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sessions: SessionManager;
let tracker: CommandTracker;
const starts: { command: string }[] = [];
const ends: { command: string; durationMs: number }[] = [];

beforeAll(() => {
  initLog('error');
  tracker = new CommandTracker({
    onStart: (_id, command) => starts.push({ command }),
    onEnd: (_id, command, durationMs) => ends.push({ command, durationMs }),
  });
  sessions = new SessionManager(config, {
    onExit: () => {},
    onStateChange: () => {},
    onCreated: (s) => tracker.add(s.id, s.pid),
    onInputWritten: (s, data) => tracker.onInput(s.id, data),
  });
});

afterAll(async () => {
  await sessions.shutdown();
});

describe('finding a real foreground process', () => {
  it('sees a command running under a real shell, with its arguments', async () => {
    const session = sessions.create({ cols: 80, rows: 24 });
    await sleep(800);
    sessions.write(session, Buffer.from('sleep 3\r'));
    await sleep(1200);

    const found = await foregroundOf(session.pid);
    expect(found).not.toBeNull();
    // The full argv, straight from the OS. Not reconstructed from keystrokes, not scraped off
    // the screen: those are heuristics that would put wrong commands in someone's history.
    expect(found?.command).toContain('sleep 3');
  });

  it('sees nothing at an idle prompt', async () => {
    const session = sessions.create({ cols: 80, rows: 24 });
    await sleep(1500);
    expect(await foregroundOf(session.pid)).toBeNull();
  });
});

describe('end to end, with no shell integration', () => {
  it('reports a command starting and finishing, with a plausible duration', async () => {
    starts.length = 0;
    ends.length = 0;
    const session = sessions.create({ cols: 80, rows: 24 });
    await sleep(800);

    sessions.write(session, Buffer.from('sleep 2\r'));
    await sleep(4500);

    expect(starts.some((s) => s.command.includes('sleep 2'))).toBe(true);
    const end = ends.find((e) => e.command.includes('sleep 2'));
    expect(end).toBeDefined();
    // Roughly two seconds. The check interval is slack on purpose, so this asserts a range
    // rather than a number.
    expect(end?.durationMs).toBeGreaterThan(1500);
    expect(end?.durationMs).toBeLessThan(5000);
  });

  it('reports nothing for a shell builtin, which spawns no process', async () => {
    // A real gap, and for `export` an improvement: the command whose text is most sensitive is
    // the one that never appears.
    starts.length = 0;
    const session = sessions.create({ cols: 80, rows: 24 });
    await sleep(800);
    sessions.write(session, Buffer.from('cd /tmp\r'));
    await sleep(1500);
    expect(starts.some((s) => s.command.includes('cd'))).toBe(false);
  });
});
