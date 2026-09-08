import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  ackFrame,
  controlFrame,
  decodeFrame,
  inputFrame,
  paneCount,
  type ControlMessage,
} from '@tabterm/shared';
import { initAuth } from './auth.js';
import { DEFAULTS, type Config } from './config.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { initLog } from './log.js';
import { ProjectIndex } from './project-index.js';
import { OutputArchive } from './output-archive.js';
import { PluginHost } from './plugin-api.js';
import { RestoreStore } from './restore-store.js';
import { ProjectTrust } from './project-trust.js';
import { DaemonServer } from './server.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * Durability behavior that only shows up against a real daemon: what survives a client going
 * away, and what is allowed to be cleaned up.
 */
const PORT = 7997;
/**
 * Deliberately tiny grace periods, so expiry is observable inside a test rather than in minutes.
 *
 * A fifth of a second rather than a whole one. Nothing rounds these to seconds: the reap is a
 * single timer of `afterSeconds * 1000`, so a fraction is a shorter timer and nothing else. This
 * file spent forty-one seconds asleep waiting out a one second policy, and it was the slowest
 * thing in the unit suite by a factor of four, which is a cost paid on every run of every loop.
 */
const GRACE_SECONDS = 0.2;
/** Comfortably past the policy plus the scheduling around it, without being a whole second. */
const PAST_GRACE = 700;
/** Scheduled, but not yet fired. */
const BEFORE_GRACE = 100;
const config: Config = {
  ...DEFAULTS,
  port: PORT,
  reapIdleShellSeconds: GRACE_SECONDS,
  reapDefaultSeconds: GRACE_SECONDS,
};

let server: DaemonServer;
let sessions: SessionManager;
let workspaces: WorkspaceStore;
let token: string;

beforeAll(async () => {
  initLog('error');
  token = initAuth();
  sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
  workspaces = new WorkspaceStore();
  sessions.isInWorkspace = (id) => workspaces.findBySession(id) !== undefined;
  sessions.panesInItsWorkspace = (id) => {
    const workspace = workspaces.findBySession(id);
    return workspace ? paneCount(workspace.layout) : 0;
  };
  // Wired the same way `main.ts` wires it, so a report about tabs can be matched to
  // sessions. Without it nothing can be mapped and the policy keeps everything, correctly.
  sessions.setWorkspaceLookup((id) => workspaces.findBySession(id)?.id);
  server = new DaemonServer(
    config,
    sessions,
    workspaces,
    new LauncherData(new Database(':memory:')),
    new ProjectTrust(new Database(':memory:')),
    new ProjectIndex(),
    new RestoreStore(new Database(':memory:')),
    new OutputArchive(new Database(':memory:')),
    new PluginHost(),
  );
  await server.listen();
});

afterAll(async () => {
  await server.close();
  await sessions.shutdown();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the thing to be true, not for a length of time.
 *
 * A fixed sleep long enough to be safe is most of what this file cost, and a fixed sleep short
 * enough to be quick is a race. Where the expectation is that something **happens**, this returns
 * as soon as it has. Where the expectation is that something does **not** happen, there is no
 * alternative to waiting, and those waits are what the short grace periods are for.
 */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await sleep(25);
}

class C {
  readonly ws: WebSocket;
  readonly seen: ControlMessage[] = [];
  streamId = 0;
  output = '';

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw: Buffer) => {
      const f = decodeFrame(new Uint8Array(raw));
      if (f.kind === 'control') this.seen.push(f.message);
      if (f.kind === 'output') {
        this.output += Buffer.from(f.data).toString('utf8');
        this.ws.send(ackFrame(f.streamId, f.data.length));
      }
    });
  }

  static async connect(id: string): Promise<C> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r, j) => {
      ws.on('open', r);
      ws.on('error', j);
    });
    const c = new C(ws);
    ws.send(controlFrame({ t: 'auth', v: PROTOCOL_VERSION, role: 'data', token, clientId: id }));
    await c.wait('auth-ok');
    return c;
  }

  send(m: ControlMessage): void {
    this.ws.send(controlFrame(m));
  }
  type(text: string): void {
    this.ws.send(inputFrame(this.streamId, new TextEncoder().encode(text)));
  }

  async wait(t: string, ms = 6000): Promise<ControlMessage> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.seen.find((m) => m.t === t);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${t}`);
      await sleep(15);
    }
  }
  close(): void {
    this.ws.close();
  }
}

/**
 * A session that represents work.
 *
 * Marked as having run something, because these tests are about not destroying what somebody
 * was doing, and a shell that has only ever printed a prompt is deliberately treated as
 * disposable. A test that used an untouched shell would be pinning the wrong rule.
 */
async function makeSession(clientId: string, used = true): Promise<{ c: C; sessionId: string }> {
  const c = await C.connect(clientId);
  c.send({ t: 'create-session', cols: 80, rows: 24 });
  const created = (await c.wait('session-created')) as unknown as {
    sessionId: string;
    streamId: number;
  };
  c.streamId = created.streamId;
  /**
   * Wait for the session to exist, which is what the sleep here was for.
   *
   * `session-created` is the daemon's answer to the request, and the manager has the session by
   * then. Six hundred milliseconds of margin on top of that, once per test in a file of twenty,
   * was twelve seconds of the unit suite spent waiting for something that had already happened.
   */
  await until(() => sessions.get(created.sessionId) !== undefined, 3000);
  const session = sessions.get(created.sessionId);
  if (session && used) session.hasRun = true;
  return { c, sessionId: created.sessionId };
}

/**
 * Somebody closed the tab this session's workspace lives in.
 *
 * The only thing that authorizes an automatic ending. Tests used to produce this by sending an
 * empty `tabs-open` report, which is a different statement entirely and one that a browser makes
 * while starting, while quitting, and from a profile that never had the workspace.
 */
function closeItsTab(sessionId: string, eventId = 'test-close'): void {
  const workspaceId = workspaces.findBySession(sessionId)?.id;
  if (workspaceId) sessions.recordTabClosed(workspaceId, eventId);
}

describe('durability', () => {
  it('keeps a workspace pane alive well past the idle grace period', async () => {
    /**
     * Closing a tab must not destroy a session, which is the whole of ADR-0012 and still holds.
     *
     * What changed is the far end: a pane with no tab is now reaped after a background timeout
     * rather than kept literally forever, because sessions survive daemon restarts and the old
     * behavior accumulated hundreds of them. Keeping them forever is still available by
     * choosing it, which is what this test now pins.
     */
    sessions.keepBackgroundSeconds = null;
    const { c, sessionId } = await makeSession('dur-1');
    c.close();
    await sleep(PAST_GRACE); // comfortably longer than the idle policy

    const session = sessions.get(sessionId);
    expect(session, 'a workspace pane must outlive its client').toBeTruthy();
    expect(session?.state).toBe('detached');
  });

  it('tells the workspace when a session is reaped, not only when a process exits', async () => {
    /**
     * Reaping removed the session from the map and never fired the exit event, so the workspace
     * was never told its pane had gone. It then outlived its session, and a tab reopened on it
     * attached to a session that did not exist and rendered nothing at all: no terminal, no
     * start screen, not even the page saying the session had expired.
     */
    let exited = 0;
    const watched = new SessionManager(
      config,
      { onExit: () => (exited += 1), onStateChange: () => {} },
      new LocalPtyBackend(),
    );
    const session = watched.create({ cols: 80, rows: 24 });
    await sleep(400);
    await watched.terminate(session, { kind: 'user-kill' });
    expect(exited, 'a reaped session must announce its exit').toBe(1);
    await watched.shutdown();
  });

  it('reaps a pane with no tab once the background timeout passes', async () => {
    sessions.keepBackgroundSeconds = 1;
    const { c, sessionId } = await makeSession('dur-bg');
    c.close();
    /**
     * Chrome says the tab is gone, which is the only thing that starts the clock now.
     *
     * Closing the socket is not enough and must not be: a tab that was backgrounded, discarded,
     * or on a machine that slept closes its socket too, and ending those was the defect this
     * replaced. The daemon acts on what the extension reports about tabs, so a test that wants
     * a reap has to report one.
     */
    closeItsTab(sessionId);
    await sleep(PAST_GRACE);

    const session = sessions.get(sessionId);
    expect(session === undefined || session.state !== 'detached').toBe(true);
    sessions.keepBackgroundSeconds = null;
  });

  it('declines to schedule a reap and says why', async () => {
    const { c, sessionId } = await makeSession('dur-2');
    c.close();
    await sleep(PAST_GRACE);
    const session = sessions.get(sessionId);
    // Never moved to expiring, because the policy declined.
    expect(session?.state).toBe('detached');
  });

  it('reaps a shell whose pane somebody closed, once its grace period passes', async () => {
    /**
     * Outside a workspace, the authorization is the pane close rather than the tab close.
     *
     * The two are different acts and they are recorded separately. A session stops being in a
     * workspace for reasons that are not acts at all, and the rules that apply out here decide
     * **how long** to wait rather than whether waiting is allowed.
     */
    const { c, sessionId } = await makeSession('dur-3');
    const ws = workspaces.findBySession(sessionId);
    if (ws) {
      const pane = workspaces.paneFor(ws, sessionId);
      if (pane) workspaces.closePane(ws.id, pane);
    }
    const session = sessions.get(sessionId);
    if (session) session.paneClosedByUser = true;
    c.close();
    await until(() => sessions.get(sessionId) === undefined);
    expect(sessions.get(sessionId), 'a closed pane is authorization enough').toBeUndefined();
  });

  it('keeps a shell that left its workspace with nobody having closed anything', async () => {
    /**
     * The same shape without the act. A workspace can stop containing a session for reasons that
     * are not somebody finishing with it, and the rules out here must not treat their own
     * existence as permission.
     */
    const { c, sessionId } = await makeSession('dur-3b');
    const ws = workspaces.findBySession(sessionId);
    if (ws) {
      const pane = workspaces.paneFor(ws, sessionId);
      if (pane) workspaces.closePane(ws.id, pane);
    }
    c.close();
    await sleep(PAST_GRACE * 4);
    expect(sessions.get(sessionId), 'nobody closed anything, so it stays').toBeTruthy();
  });

  it('a pinned session is never reaped even outside a workspace', async () => {
    const { c, sessionId } = await makeSession('dur-4');
    const session = sessions.get(sessionId);
    if (session) sessions.setPinned(session, true);
    const ws = workspaces.findBySession(sessionId);
    if (ws) {
      const pane = workspaces.paneFor(ws, sessionId);
      if (pane) workspaces.closePane(ws.id, pane);
    }
    c.close();
    await sleep(PAST_GRACE);
    expect(sessions.get(sessionId), 'pinned must win over every expiry rule').toBeTruthy();
  });

  it('reattaching cancels a scheduled reap', async () => {
    const { c, sessionId } = await makeSession('dur-5');
    const ws = workspaces.findBySession(sessionId);
    if (ws) {
      const pane = workspaces.paneFor(ws, sessionId);
      if (pane) workspaces.closePane(ws.id, pane);
    }
    c.close();
    await sleep(BEFORE_GRACE); // reap scheduled but not yet fired

    const back = await C.connect('dur-5-again');
    back.send({ t: 'attach', sessionId, cols: 80, rows: 24 });
    await back.wait('snapshot');
    await sleep(PAST_GRACE); // past when the reap would have fired

    expect(sessions.get(sessionId), 'reattach must cancel the reap').toBeTruthy();
    expect(sessions.get(sessionId)?.state).toBe('attached');
    back.close();
  });

  it('survives every client disconnecting and reconnecting', async () => {
    const { c, sessionId } = await makeSession('dur-6');
    c.type('echo DURABLE-MARKER\r');
    await sleep(900);
    c.close();
    await sleep(800);

    // This is what quitting Chrome entirely looks like from the daemon's side.
    const back = await C.connect('dur-6-again');
    back.send({ t: 'attach', sessionId, cols: 80, rows: 24 });
    const snap = (await back.wait('snapshot')) as unknown as { snapshot: { screen: string } };
    expect(snap.snapshot.screen).toContain('DURABLE-MARKER');
    back.close();
  });
});

describe('a merged-away tab, restored', () => {
  it('gets its session handed back instead of being told it expired', async () => {
    // Two tabs, each with a session. Merge the second into the first, which empties the
    // second's workspace. Chrome cannot be told to forget that tab, so restoring its URL is
    // normal, and the session is alive in the other tab rather than gone.
    const a = await makeSession('merge-a');
    const b = await makeSession('merge-b');
    b.c.type('echo MERGED-AWAY-MARKER\r');
    await sleep(900);

    const hostWorkspace = workspaces.findBySession(a.sessionId);
    const targetPane = hostWorkspace ? workspaces.paneFor(hostWorkspace, a.sessionId) : undefined;
    expect(targetPane).toBeTruthy();

    const orphanedWorkspace = workspaces.findBySession(b.sessionId)?.id;
    a.c.send({
      t: 'merge-into',
      workspaceId: hostWorkspace?.id ?? '',
      targetPaneId: targetPane ?? '',
      sessionId: b.sessionId,
      direction: 'horizontal',
    });
    await sleep(PAST_GRACE);

    // The second workspace is gone, its session now a pane in the first.
    expect(workspaces.get(orphanedWorkspace ?? '')).toBeUndefined();
    b.c.close();
    await sleep(400);

    // Restoring the closed tab: it must come back with the session, not an expiry notice.
    const restored = await C.connect('merge-b-restored');
    restored.send({
      t: 'attach-workspace',
      workspaceId: orphanedWorkspace ?? '',
      cols: 80,
      rows: 24,
    });
    const handedBack = (await restored.wait('pane-detached')) as unknown as {
      newWorkspaceId: string;
    };
    expect(handedBack.newWorkspaceId).toBeTruthy();

    restored.send({
      t: 'attach-workspace',
      workspaceId: handedBack.newWorkspaceId,
      cols: 80,
      rows: 24,
    });
    const snap = (await restored.wait('snapshot')) as unknown as { snapshot: { screen: string } };
    expect(snap.snapshot.screen, 'the same session, with its history').toContain(
      'MERGED-AWAY-MARKER',
    );

    restored.close();
    a.c.close();
  });

  it('still reports an expiry when the session is genuinely gone', async () => {
    const c = await C.connect('really-gone');
    c.send({ t: 'attach-workspace', workspaceId: 'no-such-workspace-at-all', cols: 80, rows: 24 });
    const err = (await c.wait('error')) as unknown as { code: string };
    expect(err.code).toBe('session-expired');
    c.close();
  });
});

/**
 * Bringing a session into a pane, which takes the pane over rather than splitting it.
 *
 * The offer to bring a session in only ever appears on a pane nobody has typed into, so a split
 * left an untouched shell sitting beside the session that was asked for, and the offer vanished
 * with it. The shell being replaced has done nothing, and is ended rather than left running
 * where no layout can reach it.
 */
describe('a session brought into an empty pane', () => {
  it('takes the pane over and ends the shell that was in it', async () => {
    const host = await makeSession('replace-host', false);
    const guest = await makeSession('replace-guest');
    guest.c.type('echo BROUGHT-HERE-MARKER\r');
    await sleep(900);

    const hostWorkspace = workspaces.findBySession(host.sessionId);
    const targetPane = hostWorkspace
      ? workspaces.paneFor(hostWorkspace, host.sessionId)
      : undefined;
    expect(targetPane).toBeTruthy();

    host.c.send({
      t: 'merge-into',
      workspaceId: hostWorkspace?.id ?? '',
      targetPaneId: targetPane ?? '',
      sessionId: guest.sessionId,
      direction: 'horizontal',
      replace: true,
    });
    await until(() => sessions.get(host.sessionId) === undefined);

    const after = workspaces.get(hostWorkspace?.id ?? '');
    expect(after && paneCount(after.layout), 'one pane, not two').toBe(1);
    expect(after && workspaces.sessionIds(after)).toEqual([guest.sessionId]);
    // The same pane, so whatever surrounded it is untouched.
    expect(after && workspaces.paneFor(after, guest.sessionId)).toBe(targetPane);
    // And the shell it displaced is not left running somewhere nothing can reach.
    expect(sessions.get(host.sessionId), 'the empty shell is ended').toBeFalsy();

    guest.c.close();
    host.c.close();
  });
});

describe('two views of one session', () => {
  it('mirrors rather than forking when a tab is duplicated', async () => {
    // Duplicating a Chrome tab yields two tabs at the same URL, so two frontends land on one
    // PTY. ADR-0011 chose mirroring: both stay live and see the same stream.
    const first = await makeSession('mirror-1');
    first.c.type('echo MIRROR-ORIGIN\r');
    await sleep(900);

    const second = await C.connect('mirror-2');
    second.send({ t: 'attach', sessionId: first.sessionId, cols: 80, rows: 24 });
    const snap = (await second.wait('snapshot')) as unknown as {
      snapshot: { screen: string; streamId: number };
    };
    second.streamId = snap.snapshot.streamId;

    expect(snap.snapshot.screen, 'the duplicate sees the original history').toContain(
      'MIRROR-ORIGIN',
    );
    expect(sessions.get(first.sessionId)?.clients.size, 'both views attached').toBe(2);

    // Typing in one view reaches the other, because it is one process.
    second.type('echo FROM-THE-DUPLICATE\r');
    await sleep(PAST_GRACE);
    expect(first.c.output, 'output reaches the original too').toContain('FROM-THE-DUPLICATE');

    first.c.close();
    second.close();
  });

  it('applies the minimum size across attached views, per dimension', async () => {
    const wide = await C.connect('size-wide');
    wide.send({ t: 'create-session', cols: 200, rows: 60 });
    const created = (await wide.wait('session-created')) as unknown as { sessionId: string };
    await sleep(600);

    const session = sessions.get(created.sessionId);
    expect(session?.vt.cols).toBe(200);
    expect(session?.vt.rows).toBe(60);

    // A second, smaller view joins. Any larger client would render into columns the shell does
    // not know exist, so the PTY takes the minimum of each dimension independently.
    const narrow = await C.connect('size-narrow');
    narrow.send({ t: 'attach', sessionId: created.sessionId, cols: 80, rows: 100 });
    await narrow.wait('snapshot');
    await sleep(600);

    expect(session?.vt.cols, 'narrower client wins on columns').toBe(80);
    expect(session?.vt.rows, 'shorter client wins on rows').toBe(60);

    // When the constraining view leaves, the PTY may grow back.
    narrow.close();
    await sleep(900);
    expect(session?.vt.cols).toBe(200);
    expect(session?.vt.rows).toBe(60);
    wide.close();
  });

  it('retains its last size when nobody is attached', async () => {
    const c = await C.connect('size-solo');
    c.send({ t: 'create-session', cols: 123, rows: 44 });
    const created = (await c.wait('session-created')) as unknown as { sessionId: string };
    await sleep(600);
    const session = sessions.get(created.sessionId);

    c.close();
    await sleep(900);
    // Not reset to a default: the size is whatever the last viewer left it at.
    expect(session?.vt.cols).toBe(123);
    expect(session?.vt.rows).toBe(44);
  });
});

describe('startup herd', () => {
  it('handles many tabs restoring at once without stalling', async () => {
    // Chrome restores every tab simultaneously at startup, so the daemon meets N attaches in
    // one burst, each wanting a full screen snapshot. See docs/04-session-lifecycle.md §5.
    const COUNT = 8;
    const made = await Promise.all(
      Array.from({ length: COUNT }, (_, i) => makeSession(`herd-${String(i)}`)),
    );
    for (const m of made) {
      m.c.type('for i in 1 2 3 4 5 6 7 8 9 10; do echo herd-line-$i; done\r');
    }
    await sleep(PAST_GRACE);
    for (const m of made) m.c.close();
    await sleep(800);

    // Now the burst: everything reattaches at the same instant.
    const started = Date.now();
    const clients = await Promise.all(made.map((_, i) => C.connect(`herd-restore-${String(i)}`)));
    await Promise.all(
      clients.map(async (c, i) => {
        c.send({ t: 'attach', sessionId: made[i]?.sessionId ?? '', cols: 120, rows: 40 });
        await c.wait('snapshot', 20000);
      }),
    );
    const elapsed = Date.now() - started;

    // Every one of them got its screen back.
    for (const c of clients) {
      const snap = c.seen.find((m) => m.t === 'snapshot') as unknown as
        { snapshot: { screen: string } } | undefined;
      expect(snap?.snapshot.screen).toContain('herd-line-10');
    }

    // The budget is generous on purpose: this asserts the daemon does not serialize badly or
    // deadlock under a simultaneous burst, not a precise latency figure.
    expect(
      elapsed,
      `${String(COUNT)} simultaneous restores took ${String(elapsed)}ms`,
    ).toBeLessThan(8000);
    console.warn(`      ${String(COUNT)} simultaneous restores completed in ${String(elapsed)}ms`);

    for (const c of clients) c.close();
  });
});

/**
 * An arrangement is work, even when a pane in it has printed nothing but a prompt.
 *
 * This is the shape of what happened on 2026-09-04: an extension reload closed every tab, and
 * thirty seconds later five untouched panes were gone, taking the layout with them.
 */
describe('a pane in an arrangement somebody built', () => {
  it('is not thrown away as unused when its tab closes', async () => {
    sessions.keepBackgroundSeconds = null;
    const first = await makeSession('arrangement-1', false);
    const second = await makeSession('arrangement-2', false);

    const workspace = workspaces.findBySession(first.sessionId);
    const pane = workspace ? workspaces.paneFor(workspace, first.sessionId) : undefined;
    expect(pane).toBeTruthy();
    first.c.send({
      t: 'merge-into',
      workspaceId: workspace?.id ?? '',
      targetPaneId: pane ?? '',
      sessionId: second.sessionId,
      direction: 'horizontal',
    });
    await sleep(PAST_GRACE);
    expect(
      paneCount(
        workspaces.get(workspace?.id ?? '')?.layout ?? {
          type: 'terminal',
          paneId: 'x',
          sessionId: 'y',
        },
      ),
    ).toBe(2);

    // Every tab gone, which is exactly what a reload leaves behind.
    first.c.close();
    second.c.close();
    sessions.reportOpenWorkspaces('a-browser', []);
    await sleep(PAST_GRACE);

    expect(sessions.get(first.sessionId), 'the arrangement is kept').toBeTruthy();
    expect(sessions.get(first.sessionId)?.state).not.toBe('expiring');
    expect(sessions.get(second.sessionId), 'both of its panes').toBeTruthy();
  });
});

describe('a pane nobody used', () => {
  it('goes soon after its tab closes, rather than lingering', async () => {
    // The counterpart of the test above: that one pins "never destroy work", this one pins
    // "an untouched shell is not work". Both matter, and only together.
    sessions.keepBackgroundSeconds = null;
    const { c, sessionId } = await makeSession('dur-unused', false);
    c.close();
    // The tab is genuinely gone, said explicitly, which is what the never-used rule is about.
    closeItsTab(sessionId, 'test-close-unused');
    await sleep(PAST_GRACE);
    // Scheduled rather than gone: the delay is what makes an accidental close recoverable.
    expect(sessions.get(sessionId)?.state).toBe('expiring');
  });
});

describe('two browsers reporting their tabs', () => {
  /**
   * One set replaced by whoever spoke last was wrong in the direction that ends terminals.
   *
   * Anything that can report is a browser that knows only its own tabs: a second Chrome profile,
   * another browser with the extension, or the several headless ones the suites run in. The
   * last report to arrive used to erase everybody else's, so their sessions were put on a clock
   * while their tabs sat open.
   */
  it('keeps a session that any of them still shows', async () => {
    const { c, sessionId } = await makeSession('dur-two-browsers');
    const ws = workspaces.findBySession(sessionId)?.id ?? '';
    c.close();
    sessions.keepBackgroundSeconds = 1;

    sessions.reportOpenWorkspaces('browser-a', [ws]);
    // A different browser, which has never heard of this workspace, says what it has.
    sessions.reportOpenWorkspaces('browser-b', []);
    await sleep(PAST_GRACE);

    expect(sessions.get(sessionId), 'a tab in another browser still counts').toBeTruthy();
    sessions.keepBackgroundSeconds = null;
  });

  it('keeps a session when the browser that had it open quits', async () => {
    /**
     * The inversion the review asked for, and it is the right way round.
     *
     * This used to assert that a session disappears once the browser that reported it open goes
     * away. That reads "the reporter is gone" as "the user finished", and those are not the same
     * statement at all: quitting Chrome, a crash, a machine going to sleep and an extension being
     * replaced all take the reporter with them, and none of them is anybody closing a terminal.
     *
     * A second browser saying it does not have the workspace means nothing about the first one's
     * intent. It never had it.
     *
     * The cost of this being wrong the other way is a shell that outlives its usefulness, which
     * shows up in Running Now. The cost of the old behavior was somebody's work.
     */
    const { c, sessionId } = await makeSession('dur-gone-browser');
    const ws = workspaces.findBySession(sessionId)?.id ?? '';
    c.close();
    sessions.keepBackgroundSeconds = GRACE_SECONDS;

    sessions.reportOpenWorkspaces('browser-a', [ws]);
    sessions.reportOpenWorkspaces('browser-b', []);
    // Chrome A quits: its connection goes, and with it every claim it was making.
    sessions.forgetReporter('browser-a');
    await sleep(PAST_GRACE * 3);

    expect(
      sessions.get(sessionId),
      'a browser quitting is not somebody closing a terminal',
    ).toBeTruthy();
    expect(sessions.get(sessionId)?.state).not.toBe('expiring');
    sessions.keepBackgroundSeconds = null;
  });

  it('ends it only once somebody closes that tab, whoever is still reporting', async () => {
    const { c, sessionId } = await makeSession('dur-closed-for-real');
    const ws = workspaces.findBySession(sessionId)?.id ?? '';
    c.close();
    sessions.keepBackgroundSeconds = GRACE_SECONDS;

    sessions.reportOpenWorkspaces('browser-a', [ws]);
    sessions.reportOpenWorkspaces('browser-b', []);
    sessions.forgetReporter('browser-a');
    // Now the tab is actually closed, said by the extension that watched it happen.
    sessions.recordTabClosed(ws, 'test-close-for-real');
    await until(() => sessions.get(sessionId) === undefined);

    expect(sessions.get(sessionId)).toBeUndefined();
    sessions.keepBackgroundSeconds = null;
  });
});

describe('a laptop that was closed for the night', () => {
  /**
   * Every timer is overdue on wake and they all fire at once, before Chrome has started and
   * said which tabs it has. Acting on the answer that was true when the timer was set ends
   * terminals whose tabs are sitting open on the screen the person is looking at.
   *
   * The timer means "look again", never "act on what I decided half an hour ago".
   */
  it('does not act on a decision that has since stopped being true', async () => {
    const { c, sessionId } = await makeSession('dur-woken');
    const ws = workspaces.findBySession(sessionId)?.id ?? '';
    c.close();
    /**
     * A longer window than the rest of this file uses, because the point is to come back
     * **inside** it. Everything else here waits for a policy to expire; this one has to act
     * before it does, so the window has to be long enough to act in.
     */
    sessions.keepBackgroundSeconds = 0.6;
    sessions.reportOpenWorkspaces('a-browser', []);

    // The tab comes back before the timer fires, which is what waking up looks like.
    await sleep(200);
    sessions.reportOpenWorkspaces('a-browser', [ws]);
    // And then past when it would have fired, which is the half that makes this a test.
    await sleep(900);

    expect(sessions.get(sessionId), 'the tab is open again, so it stays').toBeTruthy();
    sessions.keepBackgroundSeconds = null;
  });
});
