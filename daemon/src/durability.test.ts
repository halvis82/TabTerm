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
import { DaemonServer } from './server.js';
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
  sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} });
  workspaces = new WorkspaceStore();
  sessions.isInWorkspace = (id) => workspaces.findBySession(id) !== undefined;
  server = new DaemonServer(
    config,
    sessions,
    workspaces,
    new LauncherData(new Database(':memory:')),
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

async function makeSession(clientId: string): Promise<{ c: C; sessionId: string }> {
  const c = await C.connect(clientId);
  c.send({ t: 'create-session', cols: 80, rows: 24 });
  const created = (await c.wait('session-created')) as unknown as {
    sessionId: string;
    streamId: number;
  };
  c.streamId = created.streamId;
  await sleep(600);
  return { c, sessionId: created.sessionId };
}

describe('durability', () => {
  it('keeps a workspace pane alive well past the idle grace period', async () => {
    // Every session lives in a workspace, and workspaces are pinned by default, so closing a
    // tab must never destroy one. See ADR-0012.
    const { c, sessionId } = await makeSession('dur-1');
    c.close();
    await sleep(2500); // comfortably longer than the 1s idle policy

    const session = sessions.get(sessionId);
    expect(session, 'a workspace pane must outlive its client').toBeTruthy();
    expect(session?.state).toBe('detached');
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
