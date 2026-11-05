import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  controlFrame,
  decodeFrame,
  inputFrame,
  ackFrame,
  type ControlMessage,
} from '@tabterm/shared';
import { initAuth } from './auth.js';
import { DEFAULTS, paths, type Config } from './config.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { OutputArchive } from './output-archive.js';
import { PluginHost } from './plugin-api.js';
import { ProjectIndex } from './project-index.js';
import { ProjectTrust } from './project-trust.js';
import { PtyHost } from './pty-host/host.js';
import { PtyHostClient } from './pty-host/client.js';
import { HostPtyBackend } from './pty-host/backend.js';
import { StatsStore } from './stats-store.js';
import { RestoreStore } from './restore-store.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
import { initLog } from './log.js';

/**
 * Turning Keep alive off on a terminal already in the background starts its timeout then.
 *
 * Asked for as: "when we disable the keep alive option for a terminal session that's already in
 * the background, the timer should start then ... even if it's been in the background for longer
 * than the timer". Measured with the real timer, because the deadline is computed from when the
 * workspace went to the background, and that is the number this is about.
 */
const PORT = 7989;
const TIMEOUT_SECONDS = 1;
const config: Config = {
  ...DEFAULTS,
  port: PORT,
  reapIdleShellSeconds: TIMEOUT_SECONDS,
  reapDefaultSeconds: TIMEOUT_SECONDS,
};

let dir = '';
let host: PtyHost;
let hostClient: PtyHostClient;
let server: DaemonServer;
let sessions: SessionManager;
let workspaces: WorkspaceStore;
let token = '';
let boundPort = PORT;
let writtenLog = '';

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
    const ws = new WebSocket(`ws://127.0.0.1:${String(boundPort)}`);
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
  async wait(t: string, ms = 8000): Promise<ControlMessage> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.seen.find((m) => m.t === t);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${t}`);
      await sleep(15);
    }
  }
  async untilOutput(text: string, ms = 15000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!this.output.includes(text)) {
      if (Date.now() > deadline) throw new Error(`never saw ${JSON.stringify(text)}`);
      await sleep(15);
    }
  }
  close(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  initLog('error');
  token = initAuth();
  dir = await mkdtemp(join(tmpdir(), 'tt-unpin-'));

  /**
   * The host writes where the daemon reads.
   *
   * `historyTail` reads `paths.scrollback`, which is fixed when `config.ts` is loaded, so the
   * host is pointed at that rather than the other way round. These tests already write to the
   * real state directory, since `initAuth` puts a token there.
   */
  host = new PtyHost(join(dir, 'host.sock'), paths.scrollback);
  await host.listen();
  hostClient = new PtyHostClient({
    socketPath: join(dir, 'host.sock'),
    hostScript: join(dir, 'never-spawned'),
  });
  await hostClient.connect(4000);

  sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new HostPtyBackend(hostClient),
  );
  workspaces = new WorkspaceStore();
  sessions.isInWorkspace = (id) => workspaces.findBySession(id) !== undefined;
  sessions.setWorkspaceLookup((id) => workspaces.findBySession(id)?.id);

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
  boundPort = await server.listen();
});

afterAll(async () => {
  await server.close();
  await sessions.shutdown();
  hostClient.close();
  await host.close();
  // The one file this leaves in the real state directory.
  if (writtenLog && existsSync(writtenLog)) rmSync(writtenLog, { force: true });
  await rm(dir, { recursive: true, force: true });
});

describe('turning Keep alive off on a terminal whose tab is closed', () => {
  it('starts the timeout then, even when the tab has been gone longer than it', async () => {
    sessions.keepBackgroundSeconds = TIMEOUT_SECONDS;
    const c = await C.connect('unpin-clock');
    c.send({ t: 'create-session', cols: 80, rows: 24 });
    const created = (await c.wait('session-created')) as unknown as {
      sessionId: string;
      streamId: number;
    };
    c.streamId = created.streamId;
    writtenLog = join(paths.scrollback, `${created.sessionId}.log`);
    const session = sessions.get(created.sessionId);
    expect(session, 'the session should exist').toBeTruthy();
    if (!session) return;
    // Used, so the thirty second never-used rule is not what decides.
    session.hasRun = true;
    const workspaceId = workspaces.findBySession(created.sessionId)?.id ?? '';
    expect(workspaceId).not.toBe('');

    sessions.setPinned(session, true);
    c.close();
    sessions.recordTabClosed(workspaceId, 'unpin-clock-close');
    // Three timeouts with the tab gone, kept alive the whole time.
    await sleep(TIMEOUT_SECONDS * 3000);
    expect(sessions.get(created.sessionId), 'kept alive outlives the timeout').toBeTruthy();

    const letGo = Date.now();
    sessions.setPinned(session, false);
    await sleep(TIMEOUT_SECONDS * 500);
    expect(
      sessions.get(created.sessionId),
      'half a timeout after letting it go, it is still there',
    ).toBeTruthy();

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && sessions.get(created.sessionId) !== undefined) await sleep(25);
    expect(sessions.get(created.sessionId), 'and a timeout later it has ended').toBeUndefined();
    expect(Date.now() - letGo).toBeGreaterThanOrEqual(TIMEOUT_SECONDS * 1000 - 50);
  }, 20000);
});
