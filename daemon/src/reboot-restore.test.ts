import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  controlFrame,
  decodeFrame,
  panes,
  type ControlMessage,
  type RestorableSummary,
} from '@tabterm/shared';
import { initAuth } from './auth.js';
import { DEFAULTS, type Config } from './config.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { initLog } from './log.js';
import { ProjectIndex } from './project-index.js';
import { ProjectTrust } from './project-trust.js';
import { RestoreStore } from './restore-store.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * Reboot restore, end to end, against a simulated restart.
 *
 * The database is shared across two daemon lifetimes and the sessions are not, which is exactly
 * what a machine restart looks like from the daemon's point of view. The old workspaces are
 * gone from memory, and the only thing left is what was written down.
 */
const PORT = 7994;
const config: Config = { ...DEFAULTS, port: PORT };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One database, two daemons. This is the whole point of the test.
const db = new Database(':memory:');
let token: string;

class Client {
  readonly seen: ControlMessage[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw: Buffer) => {
      const frame = decodeFrame(new Uint8Array(raw));
      if (frame.kind === 'control') this.seen.push(frame.message);
    });
  }
  static async connect(): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${String(PORT)}`);
    await new Promise((r, j) => {
      ws.on('open', r);
      ws.on('error', j);
    });
    const c = new Client(ws);
    ws.send(controlFrame({ t: 'auth', v: PROTOCOL_VERSION, role: 'data', token, clientId: 'rr' }));
    await c.waitFor('auth-ok');
    c.seen.length = 0;
    return c;
  }
  send(m: ControlMessage): void {
    this.ws.send(controlFrame(m));
  }
  async waitFor(t: string, ms = 5000): Promise<ControlMessage> {
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

interface Daemon {
  server: DaemonServer;
  sessions: SessionManager;
  workspaces: WorkspaceStore;
}

async function startDaemon(): Promise<Daemon> {
  const sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} });
  const workspaces = new WorkspaceStore();
  sessions.isInWorkspace = (id) => workspaces.findBySession(id) !== undefined;
  const server = new DaemonServer(
    config,
    sessions,
    workspaces,
    new LauncherData(db),
    new ProjectTrust(db),
    new ProjectIndex(),
    new RestoreStore(db),
  );
  await server.listen();
  return { server, sessions, workspaces };
}

async function stopDaemon(daemon: Daemon): Promise<void> {
  // What the real shutdown path does: capture everything, then let the processes go.
  daemon.server.snapshotAll();
  await daemon.server.close();
  await daemon.sessions.shutdown();
}

let daemon: Daemon;
let dirA: string;
let dirB: string;

beforeAll(async () => {
  initLog('error');
  token = initAuth();
  // realpath, because the daemon records where a session actually is and macOS puts temp
  // directories behind a symlink. Comparing against the unresolved path would fail for a
  // reason that has nothing to do with restore.
  dirA = await realpath(await mkdtemp(join(tmpdir(), 'tabterm-rrA-')));
  dirB = await realpath(await mkdtemp(join(tmpdir(), 'tabterm-rrB-')));
  daemon = await startDaemon();
});

afterAll(async () => {
  await stopDaemon(daemon);
  db.close();
});

describe('reboot restore', () => {
  it('offers nothing while the workspaces are still running', async () => {
    const c = await Client.connect();
    c.send({ t: 'create-session', cwd: dirA, cols: 80, rows: 24 });
    await c.waitFor('session-created');
    await sleep(300);

    c.seen.length = 0;
    c.send({ t: 'list-restorable' });
    const msg = (await c.waitFor('restorable-workspaces')) as unknown as {
      workspaces: RestorableSummary[];
    };
    // Restore exists for the case where sessions are gone. Offering a live workspace back would
    // just be a way to duplicate it.
    expect(msg.workspaces).toHaveLength(0);
    c.close();
  });

  it('brings back the layout and directories after a restart, as new shells', async () => {
    // Build a two-pane workspace in two different directories.
    const c = await Client.connect();
    c.send({ t: 'create-session', cwd: dirA, cols: 80, rows: 24 });
    const created = (await c.waitFor('session-created')) as unknown as {
      workspaceId: string;
      sessionId: string;
    };
    await sleep(400);

    const ws = daemon.workspaces.get(created.workspaceId);
    const paneId = ws ? panes(ws.layout)[0]?.paneId : undefined;
    expect(paneId).toBeDefined();
    if (!paneId) return;
    c.send({
      t: 'split-pane',
      workspaceId: created.workspaceId,
      paneId,
      direction: 'horizontal',
      cwd: dirB,
      cols: 80,
      rows: 24,
    });
    await sleep(1200);

    const originalPids = daemon.sessions.all.map((s) => s.pid);
    expect(originalPids.length).toBeGreaterThanOrEqual(2);
    c.close();

    // The restart.
    await stopDaemon(daemon);
    daemon = await startDaemon();
    expect(daemon.workspaces.all).toHaveLength(0);

    const c2 = await Client.connect();
    c2.send({ t: 'list-restorable' });
    const offer = (await c2.waitFor('restorable-workspaces')) as unknown as {
      workspaces: RestorableSummary[];
    };
    const entry = offer.workspaces.find((w) => w.workspaceId === created.workspaceId);
    expect(entry).toBeDefined();
    expect(entry?.paneCount).toBe(2);
    expect(entry?.panes.map((p) => p.cwd).sort()).toEqual([dirA, dirB].sort());

    // Restore it.
    c2.seen.length = 0;
    c2.send({
      t: 'restore-workspace',
      workspaceId: created.workspaceId,
      replayCommands: false,
      cols: 80,
      rows: 24,
    });
    const restored = (await c2.waitFor('session-created')) as unknown as { workspaceId: string };
    await sleep(800);

    const rebuilt = daemon.workspaces.get(restored.workspaceId);
    expect(rebuilt).toBeDefined();
    expect(
      panes(rebuilt?.layout ?? { type: 'terminal', paneId: 'x', sessionId: 'y' }),
    ).toHaveLength(2);

    // Same directories, different processes. Both halves matter.
    const cwds = daemon.sessions.all.map((s) => s.cwd).sort();
    expect(cwds).toEqual([dirA, dirB].sort());
    for (const pid of daemon.sessions.all.map((s) => s.pid)) {
      expect(originalPids).not.toContain(pid);
    }
    c2.close();
  });

  it('says plainly that the pane was restarted, not resumed', () => {
    // The one thing this feature must never do is imply the original process is still there.
    const screens = daemon.sessions.all.map((s) => s.vt.snapshot(0).screen);
    expect(screens.some((s) => s.includes('restored'))).toBe(true);
    expect(screens.some((s) => s.includes('not the original process'))).toBe(true);
  });

  it('does not offer the same restore twice', async () => {
    const c = await Client.connect();
    c.send({ t: 'list-restorable' });
    const msg = (await c.waitFor('restorable-workspaces')) as unknown as {
      workspaces: RestorableSummary[];
    };
    // The record is spent once used. Leaving it would offer the same layout forever.
    expect(msg.workspaces.map((w) => w.workspaceId)).not.toContain('w1');
    c.close();
  });

  it('forgets a layout on request', async () => {
    const c = await Client.connect();
    c.send({ t: 'create-session', cwd: dirA, cols: 80, rows: 24 });
    const created = (await c.waitFor('session-created')) as unknown as { workspaceId: string };
    await sleep(400);
    daemon.server.snapshotWorkspace(created.workspaceId);

    c.send({ t: 'forget-restorable', workspaceId: created.workspaceId });
    await sleep(200);
    c.seen.length = 0;
    c.send({ t: 'list-restorable' });
    const msg = (await c.waitFor('restorable-workspaces')) as unknown as {
      workspaces: RestorableSummary[];
    };
    expect(msg.workspaces.map((w) => w.workspaceId)).not.toContain(created.workspaceId);
    c.close();
  });

  it('reports an unknown workspace rather than inventing one', async () => {
    const c = await Client.connect();
    c.send({
      t: 'restore-workspace',
      workspaceId: 'never-existed',
      replayCommands: false,
      cols: 80,
      rows: 24,
    });
    const err = (await c.waitFor('error')) as unknown as { code: string };
    expect(err.code).toBe('session-expired');
    c.close();
  });
});
