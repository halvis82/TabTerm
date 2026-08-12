import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, controlFrame, decodeFrame } from '@tabterm/shared';
import { initAuth } from './auth.js';
import { DEFAULTS, type Config } from './config.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { initLog } from './log.js';
import { OutputArchive } from './output-archive.js';
import { PluginHost } from './plugin-api.js';
import { ProjectIndex } from './project-index.js';
import { ProjectTrust } from './project-trust.js';
import { RestoreStore } from './restore-store.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * Shutting down must finish.
 *
 * `http.Server.close()` only calls back once every connection has closed, and a WebSocket whose
 * peer never completes the close handshake never closes. A discarded Chrome tab does exactly
 * that. The daemon then stops serving but never exits, and launchd cannot start a replacement.
 *
 * That is not hypothetical: it held a port for six days on the development machine before it
 * was noticed, because the symptom is invisible — the listener *is* released, so the port looks
 * free and only the stale process remains.
 */
const PORT = 7993;
const config: Config = { ...DEFAULTS, port: PORT };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sessions: SessionManager;
let token: string;

beforeAll(() => {
  initLog('error');
  token = initAuth();
  sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} });
});

afterAll(async () => {
  await sessions.shutdown();
});

function makeServer(): DaemonServer {
  const db = new Database(':memory:');
  return new DaemonServer(
    config,
    sessions,
    new WorkspaceStore(),
    new LauncherData(db),
    new ProjectTrust(db),
    new ProjectIndex(),
    new RestoreStore(db),
    new OutputArchive(db),
    new PluginHost(),
  );
}

describe('closing the server', () => {
  it('returns promptly with no clients at all', async () => {
    const server = makeServer();
    await server.listen();
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns even when a client never answers the close frame', async () => {
    // The bug, reproduced. A peer that receives the close frame and simply does not reply used
    // to leave http.close() pending forever.
    const server = makeServer();
    await server.listen();

    const ws = new WebSocket(`ws://127.0.0.1:${String(PORT)}`);
    await new Promise((r, j) => {
      ws.on('open', r);
      ws.on('error', j);
    });
    ws.send(
      controlFrame({ t: 'auth', v: PROTOCOL_VERSION, role: 'data', token, clientId: 'silent' }),
    );
    await new Promise<void>((resolve) => {
      ws.on('message', (raw: Buffer) => {
        const frame = decodeFrame(new Uint8Array(raw));
        if (frame.kind === 'control' && frame.message.t === 'auth-ok') resolve();
      });
    });

    // Go deaf: never respond to anything the server sends, including a close frame.
    ws.removeAllListeners('message');
    ws.on('close', () => {
      /* swallowed on purpose */
    });
    // Replacing the internal close handler is what a discarded tab effectively does: the socket
    // stays open at the OS level with nothing servicing it.
    ws.pause();

    const started = Date.now();
    await server.close();
    const elapsed = Date.now() - started;

    // Bounded by the grace period, not open-ended.
    expect(elapsed).toBeLessThan(5000);
    ws.terminate();
  });

  it('can be closed twice without hanging or throwing', async () => {
    // Shutdown paths get called from more than one place, and the second call must be harmless.
    const server = makeServer();
    await server.listen();
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('frees the port for a replacement immediately afterwards', async () => {
    // The thing that actually matters: launchd starting a new daemon must succeed.
    const first = makeServer();
    await first.listen();
    await first.close();
    await sleep(100);

    const second = makeServer();
    await expect(second.listen()).resolves.toBe(PORT);
    await second.close();
  });
});
