import { beforeEach, describe, expect, it } from 'vitest';
import { decideReap, reapInputFor } from './cleanup.js';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import type { PtyBackend, PtySpawnRequest } from './pty-backend.js';
import { DEFAULT_NOTIFY_POLICY, isAFailureWorthSaying } from './notify-policy.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * A session whose process is already gone, and everything that still loops over it.
 *
 * `exited` may only become `reaped`, so asking for `expiring` throws. That is not a stray
 * warning: the loops that reschedule reaping run over every session at once, and the throw came
 * out of a socket close handler, so a single exited session stopped the loop and every session
 * after it silently kept whatever timer it already had.
 *
 * Found in a real log: twenty nine "illegal session transition exited -> expiring" in one day.
 */

/** A backend that lets a test end a process the way the host would report it. */
class ExitableBackend implements PtyBackend {
  kills: string[] = [];
  #onSpawned: (sessionId: string, pid: number) => void = () => {};
  #onExit: (sessionId: string, exitCode: number, signal?: number) => void = () => {};
  #pid = 2000;

  spawn(req: PtySpawnRequest): void {
    this.#pid += 1;
    this.#onSpawned(req.sessionId, this.#pid);
  }
  onSpawned(fn: (sessionId: string, pid: number) => void): void {
    this.#onSpawned = fn;
  }
  onExit(fn: (sessionId: string, exitCode: number, signal?: number) => void): void {
    this.#onExit = fn;
  }
  /** Report a process ending, as the host does when a shell dies. */
  end(sessionId: string, exitCode = 1): void {
    this.#onExit(sessionId, exitCode);
  }
  write(): void {}
  inject(): void {}
  resize(): void {}
  kill(sessionId: string): Promise<void> {
    this.kills.push(sessionId);
    // A real host signals the process and the process then exits, non-zero, because that is what
    // a shell does when it is hung up on. Reporting it here is what makes this faithful: the
    // whole defect lived in the gap between the kill and the exit it causes.
    this.#onExit(sessionId, 1);
    return Promise.resolve();
  }
  onData(): void {}
  adoptable(): Promise<never[]> {
    return Promise.resolve([]);
  }
  close(): void {}
}

const config: Config = {
  ...DEFAULTS,
  reapIdleShellSeconds: 0.05,
  reapDefaultSeconds: 0.05,
  reapAgentOrEditorSeconds: 0.05,
};

let backend: ExitableBackend;
let sessions: SessionManager;
let workspaces: WorkspaceStore;
/** Every session handed to the exit handler, which is what decides whether to notify. */
let exited: { id: string; exitCode?: number; endedBy?: string }[] = [];

/** A used session in a workspace with nobody attached, which is what the loops are about. */
function aDetachedSession(clientId: string): string {
  const session = sessions.create({ cwd: '/tmp', cols: 80, rows: 24 });
  session.hasRun = true;
  workspaces.create(session.id);
  sessions.attach(session, { clientId, cols: 80, rows: 24, onOutput: () => {} });
  sessions.detach(session, clientId);
  return session.id;
}

beforeEach(() => {
  initLog('error');
  backend = new ExitableBackend();
  exited = [];
  sessions = new SessionManager(
    config,
    {
      onExit: (s) => {
        exited.push({
          id: s.id,
          ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }),
          ...(s.endedBy === undefined ? {} : { endedBy: s.endedBy }),
        });
      },
      onStateChange: () => {},
    },
    backend,
  );
  workspaces = new WorkspaceStore();
  sessions.isInWorkspace = (id) => workspaces.findBySession(id) !== undefined;
  sessions.setWorkspaceLookup((id) => workspaces.findBySession(id)?.id);
  sessions.keepBackgroundSeconds = 0.05;
});

describe('a session whose process has already ended', () => {
  it('is not scheduled for expiry, which is not a state it can reach', () => {
    const id = aDetachedSession('view-1');
    /**
     * Its tab was closed, which is what puts a session on the path to being reaped in the first
     * place. Without that the policy declines before it ever asks for a state change, and the
     * test passes for the wrong reason: this reproduction was built once without it and could
     * not tell the fix from its absence.
     */
    const workspace = workspaces.findBySession(id);
    if (workspace) sessions.recordTabClosed(workspace.id, 'close-0');
    sessions.reportOpenWorkspaces('view-1', []);

    backend.end(id);
    expect(sessions.all.find((s) => s.id === id)?.state).toBe('exited');

    // The sweep that runs whenever a browser stops speaking for its tabs.
    expect(() => {
      sessions.forgetReporter('view-1');
    }).not.toThrow();
    expect(sessions.all.find((s) => s.id === id)?.state).toBe('exited');
  });

  it('and does not stop the sessions after it from being rescheduled', () => {
    /**
     * The consequence that made this worth fixing. The loop is not guarded per session, so the
     * throw escaped the whole call and everything later in the list kept its old timer. The
     * ordering here is deliberate: the exited one is created first.
     */
    const dead = aDetachedSession('view-1');
    const alive = aDetachedSession('view-1');

    // Both tabs were closed, which is what puts either on the path to being reaped. The dead one
    // needs it to reach the state change that threw; the live one needs it so the loop has
    // something observable to do after that point.
    for (const [id, event] of [
      [dead, 'close-0'],
      [alive, 'close-1'],
    ] as const) {
      const workspace = workspaces.findBySession(id);
      if (workspace) sessions.recordTabClosed(workspace.id, event);
    }
    sessions.reportOpenWorkspaces('view-1', []);

    backend.end(dead);
    sessions.forgetReporter('view-1');

    const stillThere = sessions.all.find((s) => s.id === alive);
    expect(stillThere?.state).toBe('expiring');
    expect(stillThere?.reapTimer).toBeDefined();
  });

  it('and is never signalled, having nothing left to signal', () => {
    // Killing a process that is already gone reaches whichever host is connected now, which
    // after a host has been replaced is somebody else's session.
    const id = aDetachedSession('view-1');
    backend.end(id);
    sessions.forgetReporter('view-1');
    expect(backend.kills).toEqual([]);
  });
});

/**
 * The link between deciding to end a session and deciding whether that is worth a notification.
 *
 * `isAFailureWorthSaying` is tested on its own, and it is only as good as the field it reads. If
 * `endedBy` were not set by the time the exit handler runs, the pure function would be perfectly
 * correct and the user would still be told their process had failed, which is the bug as it
 * actually appeared. This is the seam, so this is where it is checked.
 */
describe('what the exit handler is told about a session it did not expect to end', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('carries the cause when TabTerm reaped it, so nothing is reported as a failure', async () => {
    const id = aDetachedSession('view-1');
    const workspace = workspaces.findBySession(id);
    if (workspace) sessions.recordTabClosed(workspace.id, 'close-0');
    sessions.reportOpenWorkspaces('view-1', []);
    sessions.forgetReporter('view-1');

    await sleep(300);

    const record = exited.find((e) => e.id === id);
    expect(record).toBeDefined();
    // Non-zero, exactly as the user saw it, and with the reason it happened attached.
    expect(record?.exitCode).toBe(1);
    // Closing the tab, so the cause names the tab. What matters is that a cause is there at all.
    expect(record?.endedBy).toBe('expired-after-tab-close');
    expect(isAFailureWorthSaying(record ?? {}, DEFAULT_NOTIFY_POLICY)).toBe(false);
  });

  it('and carries no cause when the process died on its own, which still reports', async () => {
    // The case the notification exists for, and the one that must survive the fix: a hidden tab
    // whose build failed, found much later otherwise.
    const id = aDetachedSession('view-2');
    backend.end(id, 1);
    await sleep(50);

    const record = exited.find((e) => e.id === id);
    expect(record?.exitCode).toBe(1);
    expect(record?.endedBy).toBeUndefined();
    expect(isAFailureWorthSaying(record ?? {}, DEFAULT_NOTIFY_POLICY)).toBe(true);
  });
});

/**
 * The clock must measure elapsed time, not time since the last time anybody asked.
 *
 * Reported from a real machine: a thirty minute timeout, sessions marked "background" for
 * fifty-three minutes, still there. The policy was correct and the timer was never allowed to
 * finish. `#scheduleReap` clears the pending timer and starts a fresh countdown on every call,
 * and the extension reports its open tabs every two minutes, which re-runs the policy for every
 * idle session. Any timeout longer than the reporting interval could therefore never elapse.
 *
 * It also explains why a probe passed against the same code: the probe reported once and then
 * disconnected, so nothing arrived to restart its countdown.
 */
describe('a reap already scheduled', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('is not postponed by the browser saying again what it already said', async () => {
    sessions.keepBackgroundSeconds = 1;
    const id = aDetachedSession('view-1');
    const workspace = workspaces.findBySession(id);
    if (workspace) sessions.recordTabClosed(workspace.id, 'close-0');
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('view-1', []);

    /**
     * Six reports inside the one second timeout, which is what a browser reporting every two
     * minutes looks like against a thirty minute one. Each says exactly what the last one said.
     */
    for (let i = 0; i < 6; i += 1) {
      await sleep(200);
      sessions.reportOpenWorkspaces('view-1', []);
    }
    await sleep(400);

    expect(sessions.get(id)).toBeUndefined();
  });

  it('and shortening the setting applies to a session already on a clock', async () => {
    /**
     * The deadline is kept across re-decisions, so it has to be dropped when the thing it was
     * measured against changes. Somebody who has just shortened the timeout means the sessions
     * they are looking at, not only the ones that detach next.
     */
    sessions.keepBackgroundSeconds = 3600;
    const id = aDetachedSession('view-3');
    const workspace = workspaces.findBySession(id);
    if (workspace) sessions.recordTabClosed(workspace.id, 'close-2');
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('view-3', []);
    expect(sessions.get(id)?.state).toBe('expiring');

    sessions.keepBackgroundSeconds = 1;
    sessions.rescheduleReaps();
    await sleep(1400);

    expect(sessions.get(id)).toBeUndefined();
  });

  it('and lengthening it does not end one early on the old deadline', async () => {
    // The other direction, which a kept deadline could get wrong: the clock must be the one in
    // force now, counted from the change, not whatever was already ticking.
    sessions.keepBackgroundSeconds = 1;
    const id = aDetachedSession('view-4');
    const workspace = workspaces.findBySession(id);
    if (workspace) sessions.recordTabClosed(workspace.id, 'close-3');
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('view-4', []);

    sessions.keepBackgroundSeconds = 3600;
    sessions.rescheduleReaps();
    await sleep(1400);

    expect(sessions.get(id)).toBeDefined();
    expect(backend.kills).toEqual([]);
  });

  it('and a tab coming back still cancels it outright', async () => {
    // The safety property the restart was there to provide. Keeping a deadline must not make a
    // session survivable only by luck: a workspace reported open again is kept, with no timer.
    sessions.keepBackgroundSeconds = 1;
    const id = aDetachedSession('view-2');
    const workspace = workspaces.findBySession(id);
    if (workspace) sessions.recordTabClosed(workspace.id, 'close-1');
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('view-2', []);
    await sleep(300);

    // The tab is open again, which beats a recorded close.
    if (workspace) sessions.reportOpenWorkspaces('view-2', [workspace.id]);
    await sleep(1200);

    const alive = sessions.get(id);
    expect(alive).toBeDefined();
    expect(alive?.state).toBe('detached');
    expect(backend.kills).toEqual([]);
  });
});

/**
 * A terminal somebody has used cannot be mistaken for one nobody ever touched.
 *
 * The short grace for an unused pane exists so a tab opened and closed by accident does not leave
 * a shell behind. It is thirty seconds, against a configured timeout of half an hour, so being
 * wrong about which one a session is costs the difference between the two.
 *
 * A daemon restart is where it goes wrong. The screen is rebuilt by replaying the host's output
 * into a brand new emulator, so for a moment a session that has run plenty looks exactly like one
 * that has run nothing. The host never forgot, which is the whole reason the fact lives there.
 */
describe('what counts as a terminal nobody has used', () => {
  const used = (over: Partial<Parameters<typeof reapInputFor>[0]>) =>
    decideReap(
      reapInputFor(
        {
          hasRun: false,
          hasInput: false,
          cwd: '/tmp',
          startedIn: '/tmp',
          pinned: false,
          persistent: false,
          clients: new Map(),
          state: 'detached',
          paneClosedByUser: false,
          lastAttachedAt: Date.now(),
          ...over,
        } as never,
        {
          inWorkspace: true,
          sharesWorkspace: false,
          closedPaneSecondsLeft: null,
          paneClosedByUser: false,
          keepBackgroundSeconds: 1800,
          tabDisposition: 'closed',
        },
      ),
      config,
    );

  it('gives an untouched shell the short grace, which is what it is for', () => {
    expect(used({}).reason).toBe('never-used');
  });

  it('but a half-typed command that was never sent is use', () => {
    // Nothing ran, nothing printed, nothing moved. The only trace is that somebody typed, and
    // that trace survives a daemon restart because the host keeps it.
    expect(used({ hasInput: true }).reason).toBe('tab-closed');
  });

  it('and so is having run something', () => {
    expect(used({ hasRun: true }).reason).toBe('tab-closed');
  });

  it('and so is having been started with a command', () => {
    expect(used({ command: ['npm', 'test'] }).reason).toBe('tab-closed');
  });

  it('and so is having moved out of the directory it opened in', () => {
    expect(used({ cwd: '/tmp/elsewhere' }).reason).toBe('tab-closed');
  });

  it('so a used session gets the timeout the person chose, not thirty seconds', () => {
    expect(used({ hasInput: true }).afterSeconds).toBe(1800);
    expect(used({}).afterSeconds).toBe(30);
  });
});

/**
 * Ending a session says what it achieved, not what it asked for.
 *
 * Reset Everything used to take the length of the session list, fire the terminations without
 * waiting, and report that number as the number ended. A host that had gone away therefore
 * produced a Reset that claimed to have ended everything while every process was still running,
 * which is the one situation where somebody most needs the truth. The outcome is now returned.
 */
describe('what ending a session reports', () => {
  it('says gone when the backend confirmed it', async () => {
    const id = aDetachedSession('view-1');
    const session = sessions.get(id);
    expect(session).toBeDefined();
    const outcome = await sessions.terminate(session as never, { kind: 'user-kill' });
    expect(outcome).toEqual({ sessionId: id, outcome: 'gone' });
    expect(sessions.get(id)).toBeUndefined();
  });

  it('and unconfirmed when it did not, keeping the record either way', async () => {
    // A host that has gone away rejects. The session keeps its record on purpose: a process
    // nothing can see, reach or end is a worse outcome than an entry in a list.
    const id = aDetachedSession('view-2');
    const session = sessions.get(id);
    backend.kill = () => Promise.reject(new Error('the PTY host did not acknowledge'));

    const outcome = await sessions.terminate(session as never, { kind: 'user-kill' });
    expect(outcome).toEqual({ sessionId: id, outcome: 'unconfirmed' });
    expect(sessions.get(id)).toBeDefined();
  });
});

/**
 * A session that has not finished starting is not idle, and may not be put on a clock.
 *
 * `expiring` is reachable only from `detached`. A session created but not yet attached is
 * `starting`, and scheduling one threw out of a loop over every session, so one session in that
 * window stopped every session after it from being reconsidered at all. The same shape as the
 * `exited` case above, a different state.
 *
 * Found by the model test, and made more likely by the daemon's own sweep, which asks this
 * question on a timer rather than only when a browser speaks.
 */
describe('a session that is still starting', () => {
  it('is not scheduled, and does not stop the sweep', () => {
    const fresh = sessions.create({ cwd: '/tmp', cols: 80, rows: 24 });
    fresh.hasRun = true;
    const workspace = workspaces.create(fresh.id).workspace;
    sessions.recordTabClosed(workspace.id, 'starting-close');
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('chrome', []);

    expect(sessions.get(fresh.id)?.state).toBe('starting');
    expect(() => {
      sessions.rescheduleIdleReaps();
    }).not.toThrow();
    expect(sessions.get(fresh.id)?.state).toBe('starting');
  });

  it('and the sessions after it are still reconsidered', () => {
    // The consequence that made this worth fixing: the throw escaped the whole loop.
    const starting = sessions.create({ cwd: '/tmp', cols: 80, rows: 24 });
    starting.hasRun = true;
    workspaces.create(starting.id);

    const idle = aDetachedSession('view-9');
    const workspace = workspaces.findBySession(idle);
    if (workspace) sessions.recordTabClosed(workspace.id, 'after-starting');
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('view-9', []);

    sessions.rescheduleIdleReaps();
    expect(sessions.get(idle)?.state).toBe('expiring');
  });
});
