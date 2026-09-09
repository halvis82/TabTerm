import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import type { PtyBackend, PtySpawnRequest } from './pty-backend.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * The invariant, driven by sequences nobody wrote down.
 *
 * Every other test in this area names a situation somebody thought of. The failures here have
 * never been in the rules: they were in an ordering nobody enumerated. A browser reconnecting
 * while another was settling, a report arriving after a detach, a timeout changed while a timer
 * was pending, a session adopted with its evidence lost.
 *
 * So this generates long random sequences of the things that really happen and asserts the one
 * thing that must always hold: **without a legitimate authorization, nothing is ever signalled.**
 * Then it asserts the other half separately, because a product that never ends anything would
 * pass the first test perfectly.
 */

class CountingBackend implements PtyBackend {
  kills: string[] = [];
  #onSpawned: (sessionId: string, pid: number) => void = () => {};
  #pid = 5000;
  spawn(req: PtySpawnRequest): void {
    this.#pid += 1;
    this.#onSpawned(req.sessionId, this.#pid);
  }
  onSpawned(fn: (sessionId: string, pid: number) => void): void {
    this.#onSpawned = fn;
  }
  write(): void {}
  inject(): void {}
  resize(): void {}
  kill(sessionId: string): Promise<void> {
    this.kills.push(sessionId);
    return Promise.resolve();
  }
  onData(): void {}
  onExit(): void {}
  adoptable(): Promise<never[]> {
    return Promise.resolve([]);
  }
  close(): void {}
}

/** Everything is measured in fractions of a second, so a sequence can outlive every timer. */
const config: Config = {
  ...DEFAULTS,
  reapIdleShellSeconds: 0.05,
  reapDefaultSeconds: 0.05,
  reapAgentOrEditorSeconds: 0.05,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let backend: CountingBackend;
let sessions: SessionManager;
let workspaces: WorkspaceStore;

beforeEach(() => {
  initLog('error');
  backend = new CountingBackend();
  sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} }, backend);
  workspaces = new WorkspaceStore();
  sessions.isInWorkspace = (id) => workspaces.findBySession(id) !== undefined;
  sessions.setWorkspaceLookup((id) => workspaces.findBySession(id)?.id);
  sessions.keepBackgroundSeconds = 0.05;
  sessions.settledAfterMs = 20;
});

/** A tiny deterministic generator, so a failure can be reproduced from its seed. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 0x1_0000_0000;
  };
}

describe('over sequences nobody wrote down', () => {
  it('never signals a process without an authorization somewhere in the sequence', async () => {
    /**
     * The steps are everything a browser, a machine and a daemon can do to **themselves**. None
     * of them is evidence that a tab went away, so none may end a terminal.
     *
     * Deliberately absent, and the list is the hypothesis:
     *
     * - closing a tab, closing a pane, killing, resetting: acts by a person
     * - **any** report that omits this workspace. A settled reporter's list is a live browser with
     *   its tabs enumerated saying it no longer has this one, which is what closing a whole
     *   window looks like from here, and is legitimately authorizing. An unsettled one is not
     *   believed yet, but it settles, so an empty report is authorization on a short delay. The
     *   first two versions of this test allowed such reports and were wrong both times: the
     *   product ended a session at seed 4 and was right to.
     *
     * What remains is reporters appearing and disappearing, reports that **do** contain the
     * workspace, attaching and detaching, sweeps, and the timeout being changed. None of those is
     * an account of the workspace being gone.
     */
    for (let seed = 1; seed <= 40; seed += 1) {
      /**
       * A fresh world per seed.
       *
       * `beforeEach` runs once per test, not once per seed, so sessions from earlier seeds
       * lingered and were legitimately reaped later: their reporters had been forgotten and their
       * evidence had moved on. The assertion then blamed the current sequence for an ending that
       * belonged to a previous one, which cost two wrong diagnoses before the trace showed the
       * kill happening after the loop had finished.
       */
      backend = new CountingBackend();
      sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} }, backend);
      workspaces = new WorkspaceStore();
      sessions.isInWorkspace = (id) => workspaces.findBySession(id) !== undefined;
      sessions.setWorkspaceLookup((id) => workspaces.findBySession(id)?.id);
      sessions.keepBackgroundSeconds = 0.05;
      sessions.settledAfterMs = 20;

      const random = rng(seed);
      const session = sessions.create({ cwd: '/tmp', cols: 80, rows: 24 });
      session.hasRun = true;
      const { workspace } = workspaces.create(session.id);

      /**
       * The browser this workspace belongs to, which is what makes any of these reports mean
       * anything. A report from a browser that never had it is noise, and the model includes
       * plenty of it below.
       */
      sessions.noteWorkspaceOwner('chrome:page', workspace.id);

      let generation = 0;
      const steps = [
        () => sessions.attach(session, { clientId: 'a', cols: 80, rows: 24, onOutput: () => {} }),
        () => sessions.detach(session, 'a'),
        () => sessions.reportOpenWorkspaces('chrome:control', [workspace.id]),
        () => sessions.reportOpenWorkspaces('second-chrome:control', [workspace.id]),
        // A third browser that also has it open. Any reporter listing it protects it.
        () => sessions.reportOpenWorkspaces('third-chrome:control', [workspace.id]),
        () => sessions.forgetReporter('chrome:control'),
        () => sessions.forgetReporter('second-chrome:control'),
        () => sessions.forgetReporter('third-chrome:control'),
        () => sessions.rescheduleIdleReaps(),
        () => sessions.rescheduleReaps(),
        () => {
          sessions.keepBackgroundSeconds = random() < 0.5 ? null : 0.05;
        },

        /**
         * A browser that has never held this workspace, saying what it has.
         *
         * Which is nothing to do with this workspace, however settled it is. Before provenance
         * existed, one of these was enough to start the clock on somebody else's terminal.
         */
        () => sessions.reportOpenWorkspaces('stranger:control', []),
        () => sessions.forgetReporter('stranger:control'),

        /**
         * Inventories that arrive out of the order they were taken in.
         *
         * The reporter is asynchronous end to end and retries for several seconds, so a snapshot
         * describing an older moment can arrive after a newer one. Numbered snapshots are what
         * stop the older one being applied; unnumbered ones stand for an older extension.
         */
        () => {
          generation += 1;
          sessions.reportOpenWorkspaces('chrome:control', [workspace.id], {
            incarnation: 'worker-1',
            generation,
          });
        },
        () => {
          // Deliberately behind whatever has already been applied.
          sessions.reportOpenWorkspaces('chrome:control', [], {
            incarnation: 'worker-1',
            generation: Math.max(0, generation - 2),
          });
        },
        () => {
          // A worker that has been replaced and counts from one again.
          sessions.reportOpenWorkspaces('chrome:control', [workspace.id], {
            incarnation: `worker-${String(Math.floor(random() * 3) + 2)}`,
            generation: 1,
          });
        },
      ];

      for (let i = 0; i < 30; i += 1) {
        const step = steps[Math.floor(random() * steps.length)];
        step?.();
        if (random() < 0.25) await sleep(15);
      }
      // Far beyond every timer in the config, several times over.
      await sleep(400);
      sessions.rescheduleIdleReaps();
      await sleep(200);

      expect({ seed, kills: backend.kills }).toEqual({ seed, kills: [] });
    }
  });

  it('but a sequence that does contain one ends exactly that session, once', async () => {
    /**
     * The other half, and the reason the first is not enough on its own: a product that never
     * ended anything would satisfy it perfectly, and this one is supposed to honour a timeout.
     */
    const session = sessions.create({ cwd: '/tmp', cols: 80, rows: 24 });
    session.hasRun = true;
    const { workspace } = workspaces.create(session.id);
    sessions.attach(session, { clientId: 'a', cols: 80, rows: 24, onOutput: () => {} });
    sessions.detach(session, 'a');

    // The one thing that authorizes it: a person closed that tab.
    sessions.recordTabClosed(workspace.id, 'model-close');
    sessions.reportOpenWorkspaces('chrome', []);

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && backend.kills.length === 0) {
      sessions.rescheduleIdleReaps();
      await sleep(20);
    }
    expect(backend.kills).toEqual([session.id]);
  });

  it('and reopening it before the timer fires cancels the authorization', async () => {
    const session = sessions.create({ cwd: '/tmp', cols: 80, rows: 24 });
    session.hasRun = true;
    const { workspace } = workspaces.create(session.id);
    sessions.attach(session, { clientId: 'a', cols: 80, rows: 24, onOutput: () => {} });
    sessions.detach(session, 'a');

    sessions.recordTabClosed(workspace.id, 'model-close-2');
    sessions.reportOpenWorkspaces('chrome', []);
    // The tab comes back, which is the case the timer exists to be cancelled by.
    sessions.reportOpenWorkspaces('chrome', [workspace.id]);

    await sleep(400);
    sessions.rescheduleIdleReaps();
    await sleep(200);
    expect(backend.kills).toEqual([]);
  });
});
