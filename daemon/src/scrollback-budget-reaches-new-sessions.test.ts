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
import { linesForBytes } from './scrollback-budget.js';

/**
 * A scrollback budget reaches the terminal opened after it, not only the ones already open.
 *
 * Changing the budget applied it to every session that existed and to the host, and left the
 * config's line count alone. That field is what a new session's terminal is built with and what
 * the snapshot handed to an attaching tab is cut to, so raising the budget did nothing for
 * anything opened afterwards until the daemon restarted.
 *
 * Worse than doing nothing, it did it later: touching the memory mode re-derives the same field
 * from the budget, so an unrelated setting made the earlier one take effect.
 *
 * Asserted against a running daemon and a real session rather than by reading `server.ts` and
 * looking for the right lines, which is how the existing tests for this setting are written and
 * why none of them saw it.
 */
const PORT = 7994;
const config: Config = { ...DEFAULTS, port: PORT };

let server: DaemonServer;
let sessions: SessionManager;
let token: string;

beforeAll(async () => {
  initLog('error');
  token = initAuth();
  sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
  server = new DaemonServer(
    config,
    sessions,
    new WorkspaceStore(),
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
      ws.once('open', r);
      ws.once('error', j);
    });
    const c = new C(ws);
    ws.send(controlFrame({ t: 'auth', v: PROTOCOL_VERSION, role: 'data', token, clientId: id }));
    await c.wait('auth-ok');
    return c;
  }

  send(msg: ControlMessage): void {
    this.ws.send(controlFrame(msg));
  }

  async wait(t: string, ms = 5000): Promise<ControlMessage> {
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

describe('a scrollback budget somebody just chose', () => {
  it('is the scrollback a terminal opened afterwards actually gets', async () => {
    const c = await C.connect('budget-1');
    // Far from the default in the direction a person would notice, so a stale value cannot
    // coincide with the right one.
    const bytes = 40 * 1024 * 1024;
    c.send({ t: 'set-scrollback-budget', bytes });
    await c.wait('scrollback-budget');

    c.send({ t: 'create-session', cols: 80, rows: 24 });
    const created = (await c.wait('session-created')) as unknown as { sessionId: string };
    const session = sessions.get(created.sessionId);

    expect(session).toBeDefined();
    expect(session?.vt.scrollback).toBe(linesForBytes(bytes));
    c.close();
  });

  /*
   * And the sessions that were already open, which is the half that always worked. Asserted here
   * too so a fix for the first half cannot quietly cost the second.
   */
  it('and reaches the terminals that were already open', async () => {
    const c = await C.connect('budget-2');
    c.send({ t: 'create-session', cols: 80, rows: 24 });
    const created = (await c.wait('session-created')) as unknown as { sessionId: string };

    const bytes = 12 * 1024 * 1024;
    c.send({ t: 'set-scrollback-budget', bytes });
    await c.wait('scrollback-budget');

    expect(sessions.get(created.sessionId)?.vt.scrollback).toBe(linesForBytes(bytes));
    c.close();
  });
});
