import { beforeEach, describe, expect, it } from 'vitest';
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
