import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';

/**
 * What a tab is called survives a refresh.
 *
 * The page learned the last command from the event that says one started, which a page that has
 * just loaded has never received. So a tab called `npm test` came back called `zsh`: the name of
 * a shell nobody was looking at rather than what the terminal had been used for. The fact lives
 * on the session now, where a reattaching page is given it.
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

describe('the last command a session ran', () => {
  it('is in the title fields a reattaching page is given', () => {
    const session = sessions.create({ cols: 80, rows: 24 });
    sessions.noteCommandStarted(session, 'npm test');
    expect(session.titleFields.lastCommand).toBe('npm test');
    void sessions.terminate(session, { kind: 'user-kill' });
  });

  it('and stays there after it has finished', () => {
    // `pendingCommand` is what is running now and goes the moment it ends. This is what the
    // terminal was last used for, which is the useful thing for a tab strip to say.
    const session = sessions.create({ cols: 80, rows: 24 });
    sessions.noteCommandStarted(session, 'cargo build');
    session.commandRunning = false;
    delete session.pendingCommand;
    expect(session.titleFields.lastCommand).toBe('cargo build');
    void sessions.terminate(session, { kind: 'user-kill' });
  });

  it('is replaced by the next one rather than accumulating', () => {
    const session = sessions.create({ cols: 80, rows: 24 });
    sessions.noteCommandStarted(session, 'ls');
    sessions.noteCommandStarted(session, 'git status');
    expect(session.titleFields.lastCommand).toBe('git status');
    void sessions.terminate(session, { kind: 'user-kill' });
  });

  it('ignores a bare Return at an empty prompt', () => {
    // That produces a command mark with nothing in it, and a tab called "" says less than one
    // called by the shell it is running.
    const session = sessions.create({ cols: 80, rows: 24 });
    sessions.noteCommandStarted(session, 'make');
    sessions.noteCommandStarted(session, '   ');
    expect(session.titleFields.lastCommand).toBe('make');
    void sessions.terminate(session, { kind: 'user-kill' });
  });

  it('and a session that has run nothing claims nothing', () => {
    const session = sessions.create({ cols: 80, rows: 24 });
    expect(session.titleFields.lastCommand).toBeUndefined();
    void sessions.terminate(session, { kind: 'user-kill' });
  });
});
