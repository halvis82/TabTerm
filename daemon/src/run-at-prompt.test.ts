import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';

/**
 * Starting something in a terminal rather than instead of one.
 *
 * A program spawned as the session's own command **is** that session: interrupting it leaves a
 * dead pane with `[finished]` in it and no prompt to come back to. That is what resuming a
 * conversation used to do, reported as "it doesn't take me to a normal terminal ... these are not
 * valid terminal sessions at all".
 *
 * Against a real shell, because the whole question is when a shell is ready to be typed at, and a
 * fake backend has no opinion about that.
 */
const config: Config = { ...DEFAULTS };
let sessions: SessionManager;

beforeAll(() => {
  initLog('error');
  sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
});

/** Watch a session's output until it says something, or give up. */
const watchFor = async (
  sessions_: SessionManager,
  session: Parameters<SessionManager['attach']>[0],
  wanted: string,
  timeoutMs = 20000,
): Promise<string> => {
  let seen = '';
  sessions_.attach(session, {
    clientId: 'watcher',
    cols: 80,
    rows: 24,
    onOutput: (data) => {
      seen += data.toString('utf8');
    },
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (seen.includes(wanted)) return seen;
    await new Promise((done) => setTimeout(done, 100));
  }
  return seen;
};

describe('a command run at the session own prompt', () => {
  it('runs, and the shell it ran in is still there afterwards', async () => {
    // Printed rather than echoed, so the check cannot pass on the typed line alone: the command
    // as typed reads `printf`, and only running it produces the word.
    const session = sessions.create({
      cols: 80,
      rows: 24,
      runAtPrompt: "printf 'PROMPT%s\\n' RAN",
    });
    const seen = await watchFor(sessions, session, 'PROMPTRAN');
    expect(seen).toContain('PROMPTRAN');
    // The point of the whole thing: a shell is still running, so there is somewhere to go back to.
    expect(session.state).not.toBe('exited');
    expect(session.command).toBeUndefined();
    await sessions.terminate(session, { kind: 'user-kill' });
  }, 30000);

  it('counts as something having been launched here', async () => {
    // Otherwise the pane is offered the folder box, and the reap policy calls it an untouched
    // shell that nobody ever used.
    const session = sessions.create({ cols: 80, rows: 24, runAtPrompt: 'true' });
    expect(session.startedWithCommand).toBe(true);
    await sessions.terminate(session, { kind: 'user-kill' });
  });

  it('is not written before the shell has printed anything', () => {
    // Text typed at a shell that has not started reading is dropped by the terminal, and what is
    // left on screen is a command sitting above a prompt that never received it.
    const session = sessions.create({ cols: 80, rows: 24, runAtPrompt: 'echo later' });
    expect(session.runAtPrompt).toBe('echo later');
    void sessions.terminate(session, { kind: 'user-kill' });
  });
});
