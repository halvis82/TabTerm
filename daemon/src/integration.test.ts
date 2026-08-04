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
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { initAuth } from './auth.js';

const PORT = 7999;
const config: Config = { ...DEFAULTS, port: PORT, scrollbackLines: 2000, reapIdleShellSeconds: 1 };

let server: DaemonServer;
let sessions: SessionManager;
let token: string;

beforeAll(async () => {
  initLog('error');
  token = initAuth();
  sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} });
  server = new DaemonServer(config, sessions);
  await server.listen();
});

afterAll(async () => {
  await server.close();
  await sessions.shutdown();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A scripted client that speaks the real wire protocol. No browser involved. */
class TestClient {
  readonly ws: WebSocket;
  readonly control: ControlMessage[] = [];
  output = '';
  streamId = 0;
  sessionId = '';

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw: Buffer) => {
      const frame = decodeFrame(new Uint8Array(raw));
      if (frame.kind === 'control') this.control.push(frame.message);
      if (frame.kind === 'output') {
        this.output += Buffer.from(frame.data).toString('utf8');
        // A real frontend acks from the xterm write callback. Without this the credit window
        // fills, the daemon stops sending, and the client is correctly treated as desynced.
        this.ws.send(ackFrame(frame.streamId, frame.data.length));
      }
    });
  }

  static async connect(clientId: string): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r, j) => {
      ws.on('open', r);
      ws.on('error', j);
    });
    const c = new TestClient(ws);
    ws.send(controlFrame({ t: 'auth', v: PROTOCOL_VERSION, role: 'data', token, clientId }));
    await c.waitFor('auth-ok');
    return c;
  }

  send(m: ControlMessage): void {
    this.ws.send(controlFrame(m));
  }
  type(text: string): void {
    this.ws.send(inputFrame(this.streamId, new TextEncoder().encode(text)));
  }

  async waitFor(t: string, ms = 5000): Promise<ControlMessage> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.control.find((m) => m.t === t);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${t}`);
      await sleep(20);
    }
  }

  async waitForOutput(re: RegExp, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!re.test(this.output)) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${String(re)}; saw: ${JSON.stringify(this.output.slice(-300))}`,
        );
      }
      await sleep(20);
    }
  }

  close(): void {
    this.ws.close();
  }
}

describe('daemon, end to end over the real protocol', () => {
  it('rejects a connection with a bad token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r, j) => {
      ws.on('open', r);
      ws.on('error', j);
    });
    ws.send(
      controlFrame({
        t: 'auth',
        v: PROTOCOL_VERSION,
        role: 'data',
        token: 'f'.repeat(64),
        clientId: 'bad',
      }),
    );
    const code = await new Promise<number>((r) => ws.on('close', (c: number) => r(c)));
    expect(code).toBe(1008);
  });

  it('closes a connection that sends anything before authenticating', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r, j) => {
      ws.on('open', r);
      ws.on('error', j);
    });
    ws.send(controlFrame({ t: 'list-sessions' }));
    const code = await new Promise<number>((r) => ws.on('close', (c: number) => r(c)));
    expect(code).toBe(1008);
  });

  it('creates a session and round-trips input to output', async () => {
    const c = await TestClient.connect('c1');
    c.send({ t: 'create-session', cols: 80, rows: 24 });
    const created = (await c.waitFor('session-created')) as {
      sessionId: string;
      streamId: number;
      pid: number;
    };
    c.sessionId = created.sessionId;
    c.streamId = created.streamId;
    expect(created.pid).toBeGreaterThan(0);

    await sleep(700);
    c.type('echo tabterm-works\r');
    await c.waitForOutput(/tabterm-works/);
    c.close();
  });

  it('keeps the process alive when a client disconnects, and restores state on reattach', async () => {
    const a = await TestClient.connect('client-a');
    a.send({ t: 'create-session', cols: 80, rows: 24 });
    const created = (await a.waitFor('session-created')) as { sessionId: string; streamId: number };
    a.sessionId = created.sessionId;
    a.streamId = created.streamId;

    await sleep(700);
    // A marker that must survive the disconnect, plus a long-running counter proving the
    // process itself was never interrupted.
    a.type('echo MARKER-BEFORE-CLOSE\r');
    await a.waitForOutput(/MARKER-BEFORE-CLOSE/);
    a.type('touch /tmp/tt-alive-$$ ; echo PID-IS-$$\r');
    await a.waitForOutput(/PID-IS-\d+/);
    const shellPid = /PID-IS-(\d+)/.exec(a.output)?.[1];
    expect(shellPid).toBeTruthy();

    // Tab closes.
    a.close();
    await sleep(300);

    const session = sessions.get(created.sessionId);
    expect(session, 'session must outlive the client').toBeTruthy();
    expect(session?.state).toBe('expiring');

    // Tab reopens and reattaches, exactly what Cmd+Shift+T does.
    const b = await TestClient.connect('client-b');
    b.send({ t: 'attach', sessionId: created.sessionId, cols: 80, rows: 24 });
    const snap = (await b.waitFor('snapshot')) as unknown as {
      snapshot: { screen: string; sessionId: string; altScreen: boolean };
    };
    b.streamId = 1;

    // The restored screen carries what was on it before the disconnect.
    expect(snap.snapshot.sessionId).toBe(created.sessionId);
    expect(snap.snapshot.screen).toContain('MARKER-BEFORE-CLOSE');

    // And the SAME shell is still running: it still knows its own pid.
    b.type('echo STILL-$$\r');
    await b.waitForOutput(new RegExp(`STILL-${shellPid as string}`));

    expect(sessions.get(created.sessionId)?.state).toBe('attached');
    b.close();
  });

  it('restores an alternate-screen application exactly', async () => {
    const c = await TestClient.connect('alt');
    c.send({ t: 'create-session', cols: 80, rows: 24 });
    const created = (await c.waitFor('session-created')) as { sessionId: string; streamId: number };
    c.streamId = created.streamId;
    await sleep(700);

    // Enter the alternate screen and draw, the case byte-log replay cannot handle.
    c.type('printf "\\033[?1049h\\033[2J\\033[HALT-SCREEN-CONTENT\\r\\n"\r');
    await c.waitForOutput(/ALT-SCREEN-CONTENT/);
    await sleep(300);
    c.close();
    await sleep(200);

    const d = await TestClient.connect('alt-2');
    d.send({ t: 'attach', sessionId: created.sessionId, cols: 80, rows: 24 });
    const snap = (await d.waitFor('snapshot')) as unknown as {
      snapshot: { screen: string; altScreen: boolean };
    };
    expect(snap.snapshot.altScreen, 'must restore INTO the alternate screen').toBe(true);
    expect(snap.snapshot.screen).toContain('ALT-SCREEN-CONTENT');
    d.close();
  });

  it('applies the minimum size across attached clients', async () => {
    const a = await TestClient.connect('sz-a');
    a.send({ t: 'create-session', cols: 120, rows: 40 });
    const created = (await a.waitFor('session-created')) as { sessionId: string };
    await sleep(400);

    const b = await TestClient.connect('sz-b');
    b.send({ t: 'attach', sessionId: created.sessionId, cols: 80, rows: 24 });
    await b.waitFor('snapshot');
    await sleep(200);

    const s = sessions.get(created.sessionId);
    expect(s?.vt.cols).toBe(80);
    expect(s?.vt.rows).toBe(24);

    // The smaller client leaves, so the PTY may grow back.
    b.close();
    await sleep(400);
    expect(s?.vt.cols).toBe(120);
    a.close();
  });

  it('survives a burst of high-volume output without dropping the connection', async () => {
    const c = await TestClient.connect('burst');
    c.send({ t: 'create-session', cols: 80, rows: 24 });
    const created = (await c.waitFor('session-created')) as { streamId: number };
    c.streamId = created.streamId;
    await sleep(700);

    c.type('yes CHONK | head -c 3000000\r');
    await sleep(4000);
    c.type('echo BURST-SURVIVED\r');
    await c.waitForOutput(/BURST-SURVIVED/, 15000);
    expect(c.ws.readyState).toBe(1);
    c.close();
  });
});
