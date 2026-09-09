import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Wait for a kill that is expected, rather than sleeping a fixed time and hoping.
 *
 * The assertions that a session is **kept** are safe with a flat sleep: waiting longer only makes
 * them stronger. The three that require a session to be ended are the opposite, and one of them
 * failed on a loaded machine with an empty kill list, because a fifty millisecond policy checked
 * four hundred milliseconds later had simply not been reached yet. A safety suite that passes
 * only on an idle machine is not evidence of anything, and it fails in the direction that looks
 * like the product is being careful, which is the hardest kind of flake to notice.
 */
async function untilKilled(sessionId: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (backend.kills.some((k) => k.sessionId === sessionId)) return;
    await sleep(10);
  }
}
/** Comfortably past every policy above, several times over. */
const WELL_PAST_EVERY_TIMER = 400;

let backend: CountingBackend;
let sessions: SessionManager;
let workspaces: WorkspaceStore;

/** A session that has been used, in a workspace, with nobody attached. The ordinary case. */
function aWorkingSession(clientId = 'chrome:page-1'): { sessionId: string; workspaceId: string } {
  const session = sessions.create({ cwd: '/tmp', cols: 80, rows: 24 });
  session.hasRun = true;
  const { workspace } = workspaces.create(session.id);
  /**
   * The browser that asked for it is recorded as having had it, which is what the server does at
   * every creation site.
   *
   * The harness used to name the tab `view-1` and the reporter `chrome`, which are one browser in
   * reality and two strangers to a rule about provenance. Sharing a profile is what makes these
   * tests describe a Chrome rather than a coincidence.
   */
  sessions.noteWorkspaceOwner(clientId, workspace.id);
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

/**
 * What a settled browser saying "I do not have it" is allowed to mean.
 *
 * WP-61 required an explicit close message for any automatic ending, which made the timeout
 * unreachable for every tab closed before that message existed: day old sessions sat in Running
 * Now marked background and outlived the setting meant to end them.
 *
 * The line moved, on purpose, and it moved to a place that keeps every case above safe. A browser
 * that has been connected and reporting for a while, with its tabs enumerated, saying it does not
 * have this workspace, is a live account of the world. Nobody connected, or a browser still waking
 * up, or an extension being replaced, is not an account of anything, and all of those are where
 * the unsafe readings came from.
 */
describe('a browser that has settled and does not have the workspace', () => {
  it('ends the session, once the timeout the person chose has passed', async () => {
    sessions.settledAfterMs = 10;
    const ctx = aWorkingSession();
    sessions.reportOpenWorkspaces('chrome', []);
    await untilKilled(ctx.sessionId);
    expect(backend.kills.map((k) => k.sessionId)).toEqual([ctx.sessionId]);
  });

  it('but not while that browser is still waking up', async () => {
    // The same report, from a browser that has only just connected. It has not finished finding
    // out what it has, and its short list says nothing about what it does not have.
    sessions.settledAfterMs = 60_000;
    const ctx = aWorkingSession();
    sessions.reportOpenWorkspaces('chrome', []);
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toEqual([]);
    expect(sessions.get(ctx.sessionId)).toBeTruthy();
  });

  it('and not while any browser is still waking up, however many have settled', async () => {
    /**
     * One unsettled reporter withholds the conclusion for everybody.
     *
     * A second profile starting up knows nothing yet, and its silence must not be read as
     * agreement with the one that has finished speaking. Waiting costs a delay; being wrong costs
     * somebody's work.
     */
    sessions.settledAfterMs = 10;
    const ctx = aWorkingSession();
    sessions.reportOpenWorkspaces('settled', []);
    await sleep(50);
    sessions.settledAfterMs = 60_000;
    sessions.reportOpenWorkspaces('just-woke', []);
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toEqual([]);
    expect(sessions.get(ctx.sessionId)).toBeTruthy();
  });

  it('keeps it when a settled browser does have it open', async () => {
    sessions.settledAfterMs = 10;
    const ctx = aWorkingSession();
    sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toEqual([]);
  });

  it('keeps it when the last browser goes away, since nobody is left to say anything', async () => {
    // Chrome quitting takes its reporter with it. That is silence again, not an account.
    sessions.settledAfterMs = 10;
    const ctx = aWorkingSession();
    sessions.reportOpenWorkspaces('chrome', [ctx.workspaceId]);
    await sleep(50);
    sessions.forgetReporter('chrome');
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toEqual([]);
    expect(sessions.get(ctx.sessionId)).toBeTruthy();
  });
});

describe('a tab somebody actually closed', () => {
  it('ends the session, which is the whole point of the timer', async () => {
    const ctx = aWorkingSession();
    sessions.recordTabClosed(ctx.workspaceId, 'close-1');
    await untilKilled(ctx.sessionId);
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
    await untilKilled(ctx.sessionId);
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

/**
 * With no durable host, a terminal is refused rather than half-made.
 *
 * `NoPtyBackend` creates no process, which is safe. What was not safe was building a session and
 * a workspace around it anyway: a pane showing nothing, a row in Running Now for a pid that does
 * not exist, and a person with no idea why.
 */
describe('when there is no durable PTY host', () => {
  it('refuses to create a session at all', async () => {
    const { NoPtyBackend } = await import('./pty-backend.js');
    const { NoDurableHostError } = await import('./session-manager.js');
    const refusing = new SessionManager(
      config,
      { onExit: () => {}, onStateChange: () => {} },
      new NoPtyBackend(),
    );
    expect(refusing.canCreate).toBe(false);
    expect(() => refusing.create({ cwd: '/tmp', cols: 80, rows: 24 })).toThrow(NoDurableHostError);
    expect(refusing.all, 'and nothing is left behind by the attempt').toEqual([]);
  });

  it('says it can create when a backend really owns processes', () => {
    expect(sessions.canCreate).toBe(true);
  });
});

/**
 * The question has to keep being asked, and one browser waking up must not answer for the rest.
 *
 * Both halves of a report from a real machine: sessions hours old under a thirty minute setting.
 * Neither cause was a rule that was too permissive. One was a rule that could not be reached, and
 * the other was a question nobody asked again.
 */
describe('a reporter that is still settling', () => {
  it('does not stop every other session from ever being judged', async () => {
    /**
     * Chrome's control client reconnects whenever its service worker sleeps and wakes, and each
     * reconnect is a new client id with a fresh timestamp. Withholding the answer while any
     * reporter is settling therefore withheld it almost always, and the timeout never applied.
     */
    sessions.settledAfterMs = 50;
    const ctx = aWorkingSession();
    // The same browser that opened it, which is the one whose absence means anything.
    sessions.reportOpenWorkspaces('chrome:control', []);
    await sleep(120);

    // And now a second browser connects, one millisecond old, with nothing to say yet.
    sessions.reportOpenWorkspaces('just-woke-up', []);

    await untilKilled(ctx.sessionId);
    expect(backend.kills.map((k) => k.sessionId)).toEqual([ctx.sessionId]);
  });

  it('but a mention by any reporter protects, even when a settled one omits it', async () => {
    /**
     * The direction that must never be lost, and the review's governing rule: a workspace named
     * by any tab report is open, and open outranks everything.
     *
     * Both reports are made before anything settles, on purpose. Letting the empty one settle
     * first and then adding the mention races a correctly scheduled reap, which is a test about
     * timing rather than about the rule.
     */
    sessions.settledAfterMs = 50;
    const ctx = aWorkingSession();
    sessions.reportOpenWorkspaces('settled-chrome', []);
    sessions.reportOpenWorkspaces('has-it-open', [ctx.workspaceId]);

    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toEqual([]);
    expect(sessions.get(ctx.sessionId)).toBeTruthy();
  });

  it('and no reporter at all is still unknown, which keeps everything', async () => {
    // Chrome quitting removes the reporter. That is absence, and absence authorizes nothing.
    const ctx = aWorkingSession();
    sessions.forgetReporter('settled-chrome');
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toEqual([]);
    expect(sessions.get(ctx.sessionId)).toBeTruthy();
  });
});

describe('the daemon asking again on its own clock', () => {
  it('notices a reporter has settled without waiting for it to speak again', async () => {
    /**
     * The sweep exists because every other trigger is an event from somewhere else. A browser
     * that reports once and then sleeps used to freeze the verdict: measured at thirty-nine
     * minutes on a real machine, against a thirty minute setting.
     */
    sessions.settledAfterMs = 200;
    const ctx = aWorkingSession();
    // One report, from a reporter too new to be believed, and then silence.
    sessions.reportOpenWorkspaces('chrome:control', []);
    await sleep(60);
    expect(backend.kills).toEqual([]);

    // Nothing further arrives. Only the daemon's own sweep runs.
    await sleep(300);
    sessions.rescheduleIdleReaps();

    await untilKilled(ctx.sessionId);
    expect(backend.kills.map((k) => k.sessionId)).toEqual([ctx.sessionId]);
  });

  it('and the sweep alone never authorizes anything', async () => {
    // Called repeatedly with no evidence of any kind. It re-asks; it does not grant.
    const ctx = aWorkingSession();
    for (let i = 0; i < 20; i += 1) {
      sessions.rescheduleIdleReaps();
      await sleep(20);
    }
    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills).toEqual([]);
    expect(sessions.get(ctx.sessionId)).toBeTruthy();
  });
});

/**
 * A terminal page cannot manufacture browser-wide state.
 *
 * `tab-closed` is the single message that creates authorization to end somebody's terminal, and
 * `tabs-open` is now believed about absence as well as presence, so a list that omits a workspace
 * is part of what can put it on a clock. Neither is something a page rendering one terminal is in
 * a position to know. Only the offscreen document has the whole picture, and it is the only thing
 * that connects as `control`.
 *
 * Checked at the handler, because that is where the role is known.
 */
describe('which connection may shape the tab lifecycle', () => {
  it('refuses both lifecycle messages from a data connection', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'server.ts'), 'utf8');
    for (const message of ['tabs-open', 'tab-closed']) {
      const handler =
        new RegExp(`case '${message}': \\{[\\s\\S]*?\\n      \\}`).exec(source)?.[0] ?? '';
      expect(handler).not.toBe('');
      // The guard, and that it comes before anything that records or reports.
      expect(handler).toContain("client.role !== 'control'");
      const guardAt = handler.indexOf("client.role !== 'control'");
      const actAt = Math.min(
        ...[handler.indexOf('recordTabClosed'), handler.indexOf('reportOpenWorkspaces')].filter(
          (i) => i >= 0,
        ),
      );
      expect(guardAt).toBeLessThan(actAt);
    }
  });
});

describe('a reporter has authority only over what it has actually seen', () => {
  /**
   * Provenance, which the settling rule on its own does not have.
   *
   * "No current list contains W, and some reporter is settled" is not evidence that W closed. It
   * is evidence that **one** browser does not have W, and a browser that has never had W cannot
   * say anything about it. Two Chrome profiles, or two browsers, produce exactly that: profile A
   * settles, reports what it has, and its list has never mentioned anything belonging to B.
   *
   * The direction of the mistake is what makes it serious. A settled stranger is enough to start
   * the clock on somebody else's terminal.
   */
  it('does not let a settled stranger authorise closing a workspace it never reported', async () => {
    const { sessionId, workspaceId } = aWorkingSession();

    // Profile B has the workspace and says so. This is the only reporter with any provenance here.
    sessions.reportOpenWorkspaces('profile-b', [workspaceId]);
    // Profile A is a different Chrome that has never held this workspace, and it is settled.
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('profile-a', []);

    // B's control connection drops, which happens whenever its service worker sleeps. The tab is
    // still there; nothing about B's socket says otherwise.
    sessions.forgetReporter('profile-b');
    // A keeps reporting what it has, which is still nothing to do with W.
    sessions.reportOpenWorkspaces('profile-a', []);

    await sleep(WELL_PAST_EVERY_TIMER);
    expect(
      backend.kills.filter((k) => k.sessionId === sessionId),
      'a browser that never reported this workspace cannot prove it closed',
    ).toEqual([]);
  });

  it('still lets the reporter that did have it say it is gone', async () => {
    // The feature that must survive the fix: one Chrome, one window closed, the same reporter
    // still alive and now giving a complete list without it.
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('profile-b', [workspaceId]);
    sessions.reportOpenWorkspaces('profile-b', []);

    await untilKilled(sessionId);
    expect(
      backend.kills.map((k) => k.sessionId),
      'a window close proven by the reporter that owned it must still work',
    ).toContain(sessionId);
  });

  it('treats an owner that vanished before saying so as unknown, not as agreement', async () => {
    // The other half of provenance. B had it, B never said it went, B is gone. Nobody knows.
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('profile-b', [workspaceId]);
    sessions.reportOpenWorkspaces('profile-a', []);
    sessions.forgetReporter('profile-b');

    await sleep(WELL_PAST_EVERY_TIMER);
    expect(backend.kills.filter((k) => k.sessionId === sessionId)).toEqual([]);
  });
});

describe('an inventory that arrives out of order', () => {
  /**
   * `reportOpenTabs` in the service worker is asynchronous from end to end: it awaits startup,
   * awaits `chrome.tabs.query`, awaits two storage writes, and then calls a sender that retries
   * for about eight seconds. It is invoked from tab events, tab creation, url changes, tab
   * replacement, browser startup, extension install and a poll alarm, so two runs overlap
   * routinely.
   *
   * Two overlapping runs can therefore reach the daemon in the opposite order to the snapshots
   * they describe. The older snapshot then replaces newer browser truth, and if the older one is
   * the empty list, it is an authorisation to end a terminal whose tab is open.
   */
  it('does not let an older snapshot replace a newer one', async () => {
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;

    // The newer snapshot: the tab is open, and the browser knows it.
    sessions.reportOpenWorkspaces('chrome:control', [workspaceId], {
      incarnation: 'worker-1',
      generation: 2,
    });
    // The older one, delayed behind it in the retry loop, describing a moment before the tab
    // existed. It must not be able to say anything about now.
    sessions.reportOpenWorkspaces('chrome:control', [], {
      incarnation: 'worker-1',
      generation: 1,
    });

    await sleep(WELL_PAST_EVERY_TIMER);
    expect(
      backend.kills.filter((k) => k.sessionId === sessionId),
      'a stale snapshot must not authorise ending a terminal whose tab is open',
    ).toEqual([]);
  });

  it('takes a newer snapshot from the same worker', async () => {
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('chrome:control', [workspaceId], {
      incarnation: 'worker-1',
      generation: 1,
    });
    sessions.reportOpenWorkspaces('chrome:control', [], {
      incarnation: 'worker-1',
      generation: 2,
    });
    await untilKilled(sessionId);
    expect(backend.kills.map((k) => k.sessionId)).toContain(sessionId);
  });

  it('starts again when the worker restarts, rather than ignoring it for ever', async () => {
    /**
     * A service worker that has been replaced counts from one again, and its first report must
     * not be discarded for being older than the numbers the previous worker reached. The
     * incarnation is what separates the two lifetimes.
     */
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;
    sessions.reportOpenWorkspaces('chrome:control', [workspaceId], {
      incarnation: 'worker-1',
      generation: 9,
    });
    sessions.reportOpenWorkspaces('chrome:control', [], {
      incarnation: 'worker-2',
      generation: 1,
    });
    await untilKilled(sessionId);
    expect(backend.kills.map((k) => k.sessionId)).toContain(sessionId);
  });
});

describe('a background clock that has already started', () => {
  /**
   * Once a session has legitimately gone to the background, the timeout somebody chose is a
   * deadline, not a countdown that restarts whenever the browser blinks.
   *
   * Chrome's control connection goes away every time its service worker sleeps, which on a real
   * machine was nine times in forty minutes. If losing the reporter erases the deadline, the
   * setting is unreachable from the other direction: not a session ended too early, but a session
   * that outlives the thirty minutes it was given, which is what was reported.
   */
  it('is not erased by the reporter going away and coming back', async () => {
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;
    // Long enough that the timer cannot fire during the test; this is about the deadline, not
    // about ending anything.
    sessions.keepBackgroundSeconds = 300;

    sessions.reportOpenWorkspaces('chrome:control', [workspaceId]);
    sessions.reportOpenWorkspaces('chrome:control', []);
    const dueAfterFirst = sessions.get(sessionId)?.reapDueAt;
    expect(dueAfterFirst, 'the clock should have started').toBeGreaterThan(0);

    // The service worker sleeps, and wakes up somewhere else in the same browser.
    sessions.forgetReporter('chrome:control');
    await sleep(60);
    sessions.reportOpenWorkspaces('chrome:control', []);

    const dueAfterReconnect = sessions.get(sessionId)?.reapDueAt;
    expect(dueAfterReconnect, 'the deadline must be the one already set, not a fresh timeout').toBe(
      dueAfterFirst,
    );
  });

  it('is cancelled outright when the tab comes back', () => {
    // The direction that must keep working: open beats everything, including a running clock.
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;
    sessions.keepBackgroundSeconds = 300;
    sessions.reportOpenWorkspaces('chrome:control', [workspaceId]);
    sessions.reportOpenWorkspaces('chrome:control', []);
    expect(sessions.get(sessionId)?.reapDueAt).toBeGreaterThan(0);

    sessions.reportOpenWorkspaces('chrome:control', [workspaceId]);
    expect(
      sessions.get(sessionId)?.reapDueAt,
      'a tab that is open again has no deadline at all',
    ).toBeUndefined();
  });

  it('still ends the session when the deadline it kept actually passes', async () => {
    // And the clock is real: keeping it across a reconnect must not mean never firing.
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;
    sessions.keepBackgroundSeconds = 0.25;
    sessions.reportOpenWorkspaces('chrome:control', [workspaceId]);
    sessions.reportOpenWorkspaces('chrome:control', []);
    sessions.forgetReporter('chrome:control');
    sessions.reportOpenWorkspaces('chrome:control', []);
    await untilKilled(sessionId);
    expect(backend.kills.map((k) => k.sessionId)).toContain(sessionId);
  });
});

describe('what a daemon restart does to a background clock', () => {
  /**
   * A daemon update must not quietly restart everybody's timeout, and must not make a session
   * unreapable either. Both are failures of the same fact: the daemon that comes back knows
   * nothing about which browser held what, or since when, unless it was written down.
   */
  it('picks up where the previous daemon left off', async () => {
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;
    sessions.keepBackgroundSeconds = 300;

    // What a previous daemon had written: this browser held it, and it went background 200s ago.
    const wentBackgroundAt = Date.now() - 200_000;
    sessions.restoreProvenance([
      { workspaceId, profile: 'chrome', backgroundSince: wentBackgroundAt },
    ]);

    // A browser connects for the first time in this daemon's life and reports what it has.
    sessions.reportOpenWorkspaces('chrome:control', []);

    const due = sessions.get(sessionId)?.reapDueAt ?? 0;
    const fromRestored = wentBackgroundAt + 300_000;
    expect(
      Math.abs(due - fromRestored) < 2000,
      `the deadline should continue from ${String(fromRestored)}, not restart; got ${String(due)}`,
    ).toBe(true);
    await sleep(20);
  });

  it('can still judge a workspace it only knows about from the previous daemon', async () => {
    // Provenance restored is provenance. Without it nothing this browser says about the workspace
    // means anything, and the session it belongs to could never reach any timeout at all.
    const { sessionId, workspaceId } = aWorkingSession();
    sessions.settledAfterMs = 0;
    sessions.keepBackgroundSeconds = 0.25;
    // Forget everything this process learned, leaving only what was written down.
    sessions.restoreProvenance([{ workspaceId, profile: 'other-browser' }]);
    sessions.reportOpenWorkspaces('other-browser:control', []);

    await untilKilled(sessionId);
    expect(backend.kills.map((k) => k.sessionId)).toContain(sessionId);
  });
});

describe('what an attach may change about a size', () => {
  /**
   * Nothing, when the page says its number is not yet settled.
   *
   * A page that has just loaded measures its pane before the layout is done and gets a box a
   * scrollbar narrower than the one it will have a second later, so an attach announced 187
   * columns where the truth was 195. Eight columns is not cosmetic: narrowing rewraps every
   * wrapped line in a session's history and widening rewraps them back, so one reattach reflowed a
   * whole session twice for a size nobody ever had, leaving fragments of earlier frames stranded
   * between the current ones.
   */
  it('does not resize a session that already has one', () => {
    const session = sessions.create({ cwd: '/tmp', cols: 195, rows: 44 });

    sessions.attach(session, {
      clientId: 'page-1',
      cols: 187,
      rows: 44,
      estimated: true,
      onOutput: () => {},
    });

    expect(session.vt.cols, 'an unsettled attach is not information about size').toBe(195);
  });

  it('but the pane measurement that follows is believed', () => {
    // The correction arrives through resize-pane within a second, and that is real information.
    const session = sessions.create({ cwd: '/tmp', cols: 195, rows: 44 });
    sessions.attach(session, {
      clientId: 'page-1',
      cols: 187,
      rows: 44,
      estimated: true,
      onOutput: () => {},
    });

    sessions.resize(session, 'page-1', 120, 30);
    expect(session.vt.cols).toBe(120);
    expect(session.vt.rows).toBe(30);
  });
});
