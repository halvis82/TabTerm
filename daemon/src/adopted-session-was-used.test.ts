import { describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { Database } from './database.js';
import { initLog } from './log.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';
import { StatsStore } from './stats-store.js';

/**
 * Whether a session that outlived the daemon counts as one somebody has worked in.
 *
 * It decides whether the offer to open a folder is drawn over the pane. That offer is for a pane
 * with nothing in it, and it was appearing over working agents after a refresh.
 *
 * The answer used to come from the screen alone: more than one line with anything on it. That is a
 * good rule for a shell and a poor one for exactly the sessions it matters most for. A full-screen
 * program draws on the alternate buffer, so an agent that has cleared and redrawn can serialize to
 * almost nothing, and the session with the most work in it reports that nothing has ever run.
 *
 * The daemon already counts commands per session for the Stats page, written as they finish and
 * kept across restarts. That answers the question directly.
 */
const config: Config = { ...DEFAULTS };

function managerWith(stats: StatsStore | null): SessionManager {
  initLog('error');
  const sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
  if (stats) sessions.everRan = (id) => (stats.forSession(id)?.commandsRun ?? 0) > 0;
  return sessions;
}

/** What the host hands back for a session it kept, with a screen that shows nothing useful. */
const adoptedWithEmptyScreen = {
  sessionId: 'adopted-1',
  pid: 424242,
  cwd: '/tmp',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
};

describe('a session adopted after a daemon restart', () => {
  it('counts as used when the record says commands have run in it', () => {
    const stats = new StatsStore(new Database(':memory:'));
    stats.sessionStarted('adopted-1', Date.now() - 60_000);
    stats.commandFinished('adopted-1', 120, 0);

    const sessions = managerWith(stats);
    const session = sessions.adopt(adoptedWithEmptyScreen);
    expect(session.hasRun).toBe(true);
    void sessions.terminate(session, { kind: 'user-kill' });
  });

  /*
   * And the rule this replaced still holds, because it is what keeps empty shells out of the
   * places that offer work to come back to. A session nobody ran anything in is not used.
   */
  it('and does not count as used when nothing has ever run in it', () => {
    const stats = new StatsStore(new Database(':memory:'));
    stats.sessionStarted('adopted-1', Date.now() - 60_000);

    const sessions = managerWith(stats);
    const session = sessions.adopt(adoptedWithEmptyScreen);
    expect(session.hasRun).toBe(false);
    void sessions.terminate(session, { kind: 'user-kill' });
  });

  /*
   * The case the record cannot answer: a pane running an agent.
   *
   * The command there is the agent itself and it runs for hours, so nothing ever finishes and the
   * counter says none. The agent draws on the alternate buffer, so the screen serializes to almost
   * nothing. Somebody has been typing prompts into it all morning, and the host keeps that across
   * a daemon restart, which is why it is asked first.
   */
  it('counts as used when somebody has typed into it, though nothing has finished', () => {
    const stats = new StatsStore(new Database(':memory:'));
    stats.sessionStarted('adopted-1', Date.now() - 3_600_000);

    const sessions = managerWith(stats);
    const session = sessions.adopt({ ...adoptedWithEmptyScreen, hasInput: true });
    expect(session.hasRun).toBe(true);
    void sessions.terminate(session, { kind: 'user-kill' });
  });

  it('and a manager with no record falls back to the screen', () => {
    const sessions = managerWith(null);
    const session = sessions.adopt(adoptedWithEmptyScreen);
    expect(session.hasRun).toBe(false);
    void sessions.terminate(session, { kind: 'user-kill' });
  });
});
