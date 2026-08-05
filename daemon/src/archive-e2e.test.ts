import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { Database } from './database.js';
import { initLog } from './log.js';
import { OutputArchive } from './output-archive.js';
import { SessionManager } from './session-manager.js';

/**
 * The archive against a real shell.
 *
 * The unit tests describe the rules; this one proves the wiring, which is where a feature like
 * this actually fails: capturing nothing because the events were never connected looks exactly
 * like capturing nothing because the feature is off.
 */
const config: Config = { ...DEFAULTS };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sessions: SessionManager;
let archive: OutputArchive;

beforeAll(() => {
  initLog('error');
  archive = new OutputArchive(new Database(':memory:'), true);
  sessions = new SessionManager(config, {
    onExit: () => {},
    onStateChange: () => {},
    onOutput: (session, chunk) => archive.write(session.id, chunk),
  });
});

afterAll(async () => {
  await sessions.shutdown();
});

describe('archiving real terminal output', () => {
  it('captures what a real command printed, between the real boundaries', async () => {
    const session = sessions.create({ cols: 80, rows: 24 });
    await sleep(600);

    // The boundaries are what the shell integration would report. Driving them directly keeps
    // this test about the archive rather than about whether a dotfile was sourced.
    archive.begin(session.id, 'echo ARCHIVE-MARKER', session.cwd);
    sessions.write(session, Buffer.from('echo ARCHIVE-MARKER\r'));
    await sleep(900);
    archive.end(session.id, 0);

    const results = archive.search({ query: 'ARCHIVE-MARKER' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.command).toBe('echo ARCHIVE-MARKER');
    // The echoed input and the output both pass through the PTY, which is what a real
    // transcript looks like.
    expect(results[0]?.output).toContain('ARCHIVE-MARKER');
  });

  it('captures nothing once it is switched off', async () => {
    archive.setEnabled(false);
    const session = sessions.create({ cols: 80, rows: 24 });
    await sleep(600);

    archive.begin(session.id, 'echo OFF-MARKER', session.cwd);
    sessions.write(session, Buffer.from('echo OFF-MARKER\r'));
    await sleep(900);
    archive.end(session.id, 0);

    expect(archive.search({ query: 'OFF-MARKER' })).toEqual([]);
    archive.setEnabled(true);
  });

  it('costs nothing while no command is being captured', async () => {
    // The common case by far: output arrives constantly and nothing is capturing. It must not
    // accumulate anywhere.
    const session = sessions.create({ cols: 80, rows: 24 });
    await sleep(600);
    sessions.write(session, Buffer.from('echo NOT-CAPTURED\r'));
    await sleep(900);
    expect(archive.search({ query: 'NOT-CAPTURED' })).toEqual([]);
  });
});
