import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, controlFrame, decodeFrame, type ControlMessage } from '@tabterm/shared';
import { initAuth } from './auth.js';
import { DEFAULTS, type Config } from './config.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { initLog } from './log.js';
import { ProjectIndex } from './project-index.js';
import { OutputArchive } from './output-archive.js';
import { PluginHost } from './plugin-api.js';
import { StatsStore } from './stats-store.js';
import { RestoreStore } from './restore-store.js';
import { ProjectTrust } from './project-trust.js';
import { DaemonServer } from './server.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * The claim from the log, made against a real daemon.
 *
 * Reconstructed from what actually happened rather than invented: a tab whose panes were 116 and
 * 42 columns, and an attach claiming 116 for both of them. It happened forty-two times in one day
 * and each one told the narrow pane it was nearly three times its width, which an agent answers by
 * redrawing its entire interface at a width the pane never had.
 *
 * The page that sent those has been fixed. This checks the daemon refuses them anyway, because the
 * next one could come from an extension that has not been reloaded or a client nobody has written.
 */
const PORT = 7993;
const config: Config = { ...DEFAULTS, port: PORT };

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
  server = new DaemonServer(
    config,
    sessions,
    workspaces,
    new LauncherData(new Database(':memory:')),
    new ProjectTrust(new Database(':memory:')),
    new ProjectIndex(),
    new RestoreStore(new Database(':memory:')),
    new StatsStore(new Database(':memory:')),
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

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw: Buffer) => {
      const f = decodeFrame(new Uint8Array(raw));
      if (f.kind === 'control') this.seen.push(f.message);
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

describe('an attach claiming one width for two panes of different widths', () => {
  it('does not move either terminal, and the panes keep the sizes they are running at', async () => {
    // The workspace is built directly: what is being checked is what the daemon does with an
    // attach, not the route a page takes to make a split.
    const wide = sessions.create({ cols: 116, rows: 45 });
    const narrow = sessions.create({ cols: 42, rows: 45 });
    const made = workspaces.create(wide.id);
    const split = workspaces.split(made.workspace.id, made.paneId, 'horizontal', narrow.id);
    workspaces.setRatio(made.workspace.id, made.paneId, 0.73);

    const panes = [
      { sessionId: wide.id, paneId: made.paneId },
      { sessionId: narrow.id, paneId: split.paneId },
    ];

    /*
     * One view, which is what a reloaded tab is.
     *
     * With a second view already attached the smallest claim wins and would have hidden this
     * entirely: the narrow pane keeps 42 because the other view still says 42. The log shows the
     * case that actually bites, a page that has just loaded and is the only thing looking.
     */
    const before = panes.map((p) => sessions.get(p.sessionId)?.vt.cols);
    expect(before).toEqual([116, 42]);

    const second = await C.connect('claims-2');
    second.send({
      t: 'attach-workspace',
      workspaceId: made.workspace.id,
      cols: 116,
      rows: 45,
      panes: panes.map((p) => ({ paneId: p.paneId, cols: 116, rows: 45 })),
    });
    await second.wait('workspace-attached');
    await sleep(500);

    /*
     * The attach really happened, which the check has to establish before it means anything.
     *
     * An earlier version of this asserted the sizes had not moved and passed whether or not the
     * guard was there, because the attach had silently done nothing at all. A check that cannot
     * fail is worse than no check.
     */
    const attachedTo = panes.map((p) => sessions.get(p.sessionId)?.clients.size ?? 0);
    expect(attachedTo.every((n) => n >= 1)).toBe(true);

    const after = panes.map((p) => sessions.get(p.sessionId)?.vt.cols);
    expect(after).toEqual(before);

    second.close();
  });
});
