import { beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import type { PtyBackend, PtySpawnRequest } from './pty-backend.js';

/**
 * The invariant this product is built around, stated once and then attacked.
 *
 * TabTerm must never end a live terminal without positive evidence of a deliberate act that
 * authorizes it. Everything a browser, a machine, a network or a daemon can do to itself is not
 * such an act: quitting, crashing, sleeping, reloading, restarting, disconnecting, reporting late
 * or reporting nothing.
 *
 * These tests run those sequences against a real `SessionManager` and a backend that does nothing
 * but count. The assertion is almost always the same one: `kills === 0`. A shell that outlives
 * its usefulness is visible in Running Now and can be ended by hand. A shell that TabTerm ended
 * on a guess is somebody's work.
 */

/** A backend that owns nothing and remembers every destructive request made of it. */
class CountingBackend implements PtyBackend {
  kills: { sessionId: string; keepHistory: boolean }[] = [];
  #onSpawned: (sessionId: string, pid: number) => void = () => {};
  #pid = 1000;

  spawn(req: PtySpawnRequest): void {
    this.#pid += 1;
    // Synchronously, so a test can act on a session the moment it asks for one.
    this.#onSpawned(req.sessionId, this.#pid);
  }
  onSpawned(fn: (sessionId: string, pid: number) => void): void {
    this.#onSpawned = fn;
  }
  write(): void {}
  inject(): void {}
  resize(): void {}
  kill(sessionId: string, keepHistory = false): Promise<void> {
    this.kills.push({ sessionId, keepHistory });
    return Promise.resolve();
  }
  onData(): void {}
  onExit(): void {}
  adoptable(): Promise<never[]> {
    return Promise.resolve([]);
  }
  close(): void {}
}

/**
 * Grace periods measured in fractions of a second.
 *
 * Every wait in this file is "long enough that a timer would have fired if one had been set", so
 * the shorter the policy the sharper the test. Nothing here depends on a real shell.
 */
const config: Config = {
  ...DEFAULTS,
  reapIdleShellSeconds: 0.05,
  reapDefaultSeconds: 0.05,
  reapAgentOrEditorSeconds: 0.05,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Comfortably past every policy above, several times over. */
const WELL_PAST_EVERY_TIMER = 400;

let backend: CountingBackend;
let sessions: SessionManager;
let workspaces: WorkspaceStore;

/** A session that has been used, in a workspace, with nobody attached. The ordinary case. */
function aWorkingSession(clientId = 'view-1'): { sessionId: string; workspaceId: string } {
  const session = sessions.create({ cwd: '/tmp', cols: 80, rows: 24 });
  session.hasRun = true;
  const { workspace } = workspaces.create(session.id);
  // Attached and then detached, which is what a tab opening and its socket going away looks like.
  sessions.attach(session, { clientId, cols: 80, rows: 24, onOutput: () => {} });
  sessions.detach(session, clientId);
  return { sessionId: session.id, workspaceId: workspace.id };
}

beforeEach(() => {
  initLog('error');
  backend = new CountingBackend();
  sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} }, backend);
  workspaces = new WorkspaceStore();
  sessions.isInWorkspace = (id) => workspaces.findBySession(id) !== undefined;
  sessions.setWorkspaceLookup((id) => workspaces.findBySession(id)?.id);
  sessions.keepBackgroundSeconds = 0.05;
});

describe('the view layer cannot end a terminal, whatever it does', () => {
  /**
   * Each case is a thing that really happens, and none of them is somebody saying they are
   * finished. The list is the point: every one of these used to be indistinguishable from a
   * deliberate close at the moment destruction became possible.
   */
  const sequences: [name: string, run: (ctx: ReturnType<typeof aWorkingSession>) => void][] = [
    ['the data socket simply closes', () => {}],
    [
      'Chrome quits, so its reporter goes with it',
      (ctx) => {
        sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
        sessions.forgetReporter('chrome');
      },
    ],
    [
      'a window closes, and every tab in it goes at once',
      (ctx) => {
        sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
        // A window closing produces no close evidence at all, by design. See the service worker.
        sessions.reportOpenWorkspaces('chrome', []);
      },
    ],
    ['Chrome crashes before saying anything', () => {}],
    [
      'the extension is reloaded, so its pages are destroyed and rebuilt',
      (ctx) => {
        sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
        sessions.reportOpenWorkspaces('chrome', []);
        sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
      },
    ],
    [
      'a report arrives empty because the worker woke before the tabs were queried',
      () => {
        sessions.reportOpenWorkspaces('chrome', []);
      },
    ],
    [
      'a stale report arrives after a newer one, out of order',
      (ctx) => {
        sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
        sessions.reportOpenWorkspaces('chrome', []);
        sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
        sessions.reportOpenWorkspaces('chrome', []);
      },
    ],
    [
      'a second profile says it does not have the workspace',
      (ctx) => {
        sessions.reportOpenWorkspaces('chrome-a', [ctx.workspaceId]);
        sessions.reportOpenWorkspaces('chrome-b', []);
      },
    ],
    [
      'the profile that had it quits, and the other one still says nothing about it',
      (ctx) => {
        sessions.reportOpenWorkspaces('chrome-a', [ctx.workspaceId]);
        sessions.reportOpenWorkspaces('chrome-b', []);
        sessions.forgetReporter('chrome-a');
      },
    ],
    [
      'nobody has reported anything at all yet, which is every startup',
      () => {
        sessions.rescheduleReaps();
      },
    ],
    [
      'the machine slept, so every timer is overdue at once',
      (ctx) => {
        sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
        sessions.rescheduleReaps();
      },
    ],
    [
      'a tab is discarded by Chrome to save memory, and reappears',
      (ctx) => {
        sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
        sessions.rescheduleReaps();
        sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
      },
    ],
  ];

  for (const [name, run] of sequences) {
    it(`keeps the terminal when ${name}`, async () => {
      const ctx = aWorkingSession();
      run(ctx);
      await sleep(WELL_PAST_EVERY_TIMER);
      expect(backend.kills, `${name} must not end anything`).toEqual([]);
      expect(sessions.get(ctx.sessionId), 'and the session is still here').toBeTruthy();
    });
  }
});

describe('a tab somebody actually closed', () => {
  it('ends the session, which is the whole point of the timer', async () => {
    const ctx = aWorkingSession();
    sessions.recordTabClosed(ctx.workspaceId, 'close-1');
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills.map((k) => k.sessionId)).toEqual([ctx.sessionId]);
  });

  it('does not, if the workspace is open again before the timer fires', async () => {
    sessions.keepBackgroundSeconds = 0.25;
    const ctx = aWorkingSession();
    sessions.recordTabClosed(ctx.workspaceId, 'close-2');
    // Reopened, which is what Command+Shift+T does.
    sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toEqual([]);
  });

  it('does not, if the evidence has been withdrawn before the timer fires', async () => {
    /**
     * The timer means "look again", never "permission was granted half an hour ago".
     *
     * A close that has since been contradicted has to stop authorizing anything, and the
     * authorization is fetched at the moment of use rather than captured when the timer was set.
     */
    sessions.keepBackgroundSeconds = 0.25;
    const ctx = aWorkingSession();
    sessions.recordTabClosed(ctx.workspaceId, 'close-3');
    sessions.forgetTabClosed(ctx.workspaceId);
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toEqual([]);
  });

  it('names the closing that authorized it, so it can be traced', async () => {
    const ctx = aWorkingSession();
    sessions.recordTabClosed(ctx.workspaceId, 'close-4');
    const evidence = sessions.closeEvidence(ctx.workspaceId);
    expect(evidence?.eventId).toBe('close-4');
    expect(evidence?.at).toBeGreaterThan(0);
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toHaveLength(1);
  });

  it('leaves a duplicate tab alone, since one of two closing is not both', async () => {
    const ctx = aWorkingSession();
    // Two views of the same workspace. One closes; the other is still reporting it.
    sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
    sessions.recordTabClosed(ctx.workspaceId, 'close-5');
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills, 'a tab still showing it outranks a close').toEqual([]);
  });
});

describe('reconciling records never signals anything', () => {
  it('forgetting a session the backend has lost sends no kill', () => {
    const ctx = aWorkingSession();
    const session = sessions.get(ctx.sessionId);
    expect(session).toBeTruthy();
    if (session) sessions.forgetLostSession(session, 'test');
    expect(backend.kills, 'the process is already gone; there is nothing to signal').toEqual([]);
    expect(sessions.get(ctx.sessionId), 'and the record is let go of').toBeUndefined();
  });
});
