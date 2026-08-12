import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';

/**
 * A terminal hands you your environment, not the daemon's.
 *
 * The daemon happens to be a Node process. When it runs from the app bundle its launcher sets
 * `NODE_PATH` so it can find its own native `node-pty`, and everything in the daemon's
 * environment used to be copied into every shell. That puts TabTerm's `node_modules` on the
 * module resolution path of every `node` command a user runs, which produces a project
 * resolving a dependency it never installed from a directory it has never heard of.
 */
const config: Config = { ...DEFAULTS };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sessions: SessionManager;

beforeAll(() => {
  initLog('error');
  sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
});

afterAll(async () => {
  await sessions.shutdown();
});

async function envOf(name: string): Promise<string> {
  const session = sessions.create({ cols: 200, rows: 24 });
  await sleep(700);
  sessions.write(session, Buffer.from(`echo "MARK:[$${name}]"\r`));
  await sleep(900);
  const screen = session.vt.snapshot(0).screen;

  // The typed line is echoed back before the shell runs it, so the screen holds the marker
  // twice: once with the variable unexpanded and once with its value. The last one is the
  // answer. Reading the first gave the literal `$NAME` and made every assertion here wrong.
  const matches = [...screen.matchAll(/MARK:\[([^\]]*)\]/g)];
  return matches[matches.length - 1]?.[1] ?? '';
}

describe('the environment a shell is given', () => {
  it('does not leak NODE_PATH from the daemon', async () => {
    process.env['NODE_PATH'] = '/somewhere/tabterm/node_modules';
    expect(await envOf('NODE_PATH')).toBe('');
    delete process.env['NODE_PATH'];
  });

  it('does not leak NODE_OPTIONS either', async () => {
    // It would silently apply to every Node process started in the terminal.
    process.env['NODE_OPTIONS'] = '--max-old-space-size=99';
    expect(await envOf('NODE_OPTIONS')).toBe('');
    delete process.env['NODE_OPTIONS'];
  });

  it('does not leak the daemon-internal variables', async () => {
    process.env['TABTERM_SECRET_THING'] = 'nope';
    expect(await envOf('TABTERM_SECRET_THING')).toBe('');
    delete process.env['TABTERM_SECRET_THING'];
  });

  it('still passes ordinary environment through', async () => {
    // Stripping too much would be its own bug: this is the user's shell.
    process.env['TT_ORDINARY'] = 'kept';
    expect(await envOf('TT_ORDINARY')).toBe('kept');
    delete process.env['TT_ORDINARY'];
  });

  it('tells the shell which session it is', async () => {
    expect(await envOf('TABTERM_SESSION')).not.toBe('');
  });
});
