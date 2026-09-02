import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  ackFrame,
  controlFrame,
  decodeFrame,
  inputFrame,
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
// Deliberately tiny grace periods, so expiry is observable inside a test rather than in minutes.
const config: Config = { ...DEFAULTS, port: PORT, reapIdleShellSeconds: 1, reapDefaultSeconds: 1 };

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
  await sleep(600);
  const session = sessions.get(created.sessionId);
  if (session && used) session.hasRun = true;
  return { c, sessionId: created.sessionId };
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
    await sleep(2500); // comfortably longer than the 1s idle policy

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
    await watched.kill(session);
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
    sessions.reportOpenWorkspaces('a-browser', []);
    await sleep(2500);

    const session = sessions.get(sessionId);
    expect(session === undefined || session.state !== 'detached').toBe(true);
    sessions.keepBackgroundSeconds = null;
  });

  it('declines to schedule a reap and says why', async () => {
    const { c, sessionId } = await makeSession('dur-2');
    c.close();
    await sleep(1200);
    const session = sessions.get(sessionId);
    // Never moved to expiring, because the policy declined.
    expect(session?.state).toBe('detached');
  });

  it('reaps a session that is not in a workspace once its grace period passes', async () => {
    const { c, sessionId } = await makeSession('dur-3');
    sessions.reportOpenWorkspaces('a-browser', []);
    // Outside a workspace the idle-shell rule applies, which is faster than the never-used one.
    // Remove it from its workspace so the protection no longer applies.
    const ws = workspaces.findBySession(sessionId);
    if (ws) {
      const pane = workspaces.paneFor(ws, sessionId);
      if (pane) workspaces.closePane(ws.id, pane);
    }
    c.close();
    await sleep(3000);
    expect(sessions.get(sessionId), 'an unprotected idle shell should be reaped').toBeUndefined();
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
    await sleep(3000);
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
    await sleep(500); // reap scheduled but not yet fired

    const back = await C.connect('dur-5-again');
    back.send({ t: 'attach', sessionId, cols: 80, rows: 24 });
    await back.wait('snapshot');
    await sleep(2500); // past when the reap would have fired

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
    await sleep(1200);

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
    await sleep(1200);
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
    await sleep(1500);
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

describe('a pane nobody used', () => {
  it('goes soon after its tab closes, rather than lingering', async () => {
    // The counterpart of the test above: that one pins "never destroy work", this one pins
    // "an untouched shell is not work". Both matter, and only together.
    sessions.keepBackgroundSeconds = null;
    const { c, sessionId } = await makeSession('dur-unused', false);
    c.close();
    // The tab is genuinely gone, which is what the never-used rule is about.
    sessions.reportOpenWorkspaces('a-browser', []);
    await sleep(1200);
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
    await sleep(2000);

    expect(sessions.get(sessionId), 'a tab in another browser still counts').toBeTruthy();
    sessions.keepBackgroundSeconds = null;
  });

  it('stops trusting a browser that has gone', async () => {
    const { c, sessionId } = await makeSession('dur-gone-browser');
    const ws = workspaces.findBySession(sessionId)?.id ?? '';
    c.close();
    sessions.keepBackgroundSeconds = 1;

    sessions.reportOpenWorkspaces('browser-a', [ws]);
    sessions.reportOpenWorkspaces('browser-b', []);
    // Chrome A quits. Its last report is not evidence about the world any more.
    sessions.forgetReporter('browser-a');
    await sleep(2500);

    expect(sessions.get(sessionId)).toBeUndefined();
    sessions.keepBackgroundSeconds = null;
  });
});
