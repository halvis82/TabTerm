import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import type { PtyBackend, PtySpawnRequest } from './pty-backend.js';
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
  sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} }, backend);
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
