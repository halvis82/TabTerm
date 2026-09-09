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
import { RestoreStore } from './restore-store.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
import { initLog } from './log.js';

/**
 * What a tab has left to show when the session it held expired.
 *
 * Built, plumbed and shipped without this. `lastScreen` appeared five times in the source and in
 * no test, and the reason is that producing one needs a session that reached its background
 * timeout rather than one something killed, while killing is what tests do.
 *
 * It also needs the **real** PTY host. The local backend does not write scrollback at all, so a
 * version of this written against it passed everything up to the last line and then found an empty
 * screen, which says nothing about the product. The host is what writes the file this reads.
 *
 * The distinction being pinned matters to a person, not only to the code: a session somebody ends
 * takes its history with it, and a session that expired on its own leaves it behind, precisely so
 * a tab that is still open can say what was there.
 */
const PORT = 7996;
const GRACE_SECONDS = 0.2;
const config: Config = {
  ...DEFAULTS,
  port: PORT,
  reapIdleShellSeconds: GRACE_SECONDS,
  reapDefaultSeconds: GRACE_SECONDS,
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
  dir = await mkdtemp(join(tmpdir(), 'tt-expired-'));

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

describe('a tab whose session expired', () => {
  it('is recalled with the last thing that was on its screen', async () => {
    const marker = `EXPIRED-${String(Date.now()).slice(-6)}`;
    sessions.keepBackgroundSeconds = GRACE_SECONDS;

    const c = await C.connect('expired-recall');
    c.send({ t: 'create-session', cols: 80, rows: 24 });
    const created = (await c.wait('session-created')) as unknown as {
      sessionId: string;
      streamId: number;
    };
    c.streamId = created.streamId;
    writtenLog = join(paths.scrollback, `${created.sessionId}.log`);

    const session = sessions.get(created.sessionId);
    expect(session, 'the session should exist').toBeTruthy();
    if (session) session.hasRun = true;
    const workspaceId = workspaces.findBySession(created.sessionId)?.id ?? '';
    expect(workspaceId, 'a session needs a workspace to be recalled by').not.toBe('');

    c.type(`echo ${marker}\r`);
    await c.untilOutput(marker);

    // A closed tab is the only thing that authorises an automatic ending. Then a real wait, for a
    // real timeout, which is the whole point of this file.
    c.close();
    sessions.recordTabClosed(workspaceId, 'expired-recall-close');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && sessions.get(created.sessionId) !== undefined) await sleep(25);
    expect(sessions.get(created.sessionId), 'it should have expired by now').toBeUndefined();

    const back = await C.connect('expired-recall-again');
    back.send({ t: 'recall-workspace', workspaceId });
    const recall = (await back.wait('workspace-recall')) as unknown as {
      found: boolean;
      lastScreen?: readonly string[];
    };
    back.close();

    expect(recall.found).toBe(true);
    expect((recall.lastScreen ?? []).join('\n')).toContain(marker);
  }, 30000);
});
