import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  controlFrame,
  decodeFrame,
  type ControlMessage,
  type LiveSession,
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
 * What "running now" is allowed to contain.
 *
 * The list exists to show a person the terminals they have going somewhere else. A shell that
 * has printed a prompt and nothing more is not one of those, so the rule is that a session
 * earns its place by running something, and keeps it for as long as it lives.
 */
const PORT = 7994;
const config: Config = { ...DEFAULTS, port: PORT };

let server: DaemonServer;
let sessions: SessionManager;

beforeAll(async () => {
  initLog('error');
  const token = initAuth();
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
    new OutputArchive(new Database(':memory:')),
    new PluginHost(),
  );
  await server.listen();
  authToken = token;
});

let authToken: string;

afterAll(async () => {
  await server.close();
  await sessions.shutdown();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listed(): Promise<readonly LiveSession[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const seen: ControlMessage[] = [];
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  ws.on('message', (raw: Buffer) => {
    const frame = decodeFrame(new Uint8Array(raw));
    if (frame.kind === 'control') seen.push(frame.message);
  });
  ws.send(
    controlFrame({
      t: 'auth',
      v: PROTOCOL_VERSION,
      role: 'data',
      token: authToken,
      clientId: 'ls',
    }),
  );
  ws.send(controlFrame({ t: 'list-live-sessions' }));
  const deadline = Date.now() + 4000;
  for (;;) {
    const hit = seen.find((m) => m.t === 'live-sessions');
    if (hit) {
      ws.close();
      return (hit as unknown as { sessions: readonly LiveSession[] }).sessions;
    }
    if (Date.now() > deadline) {
      ws.close();
      throw new Error('timed out waiting for live-sessions');
    }
    await sleep(15);
  }
}

describe('running now', () => {
  it('leaves out a shell that has only ever shown a prompt', async () => {
    const fresh = sessions.create({ cols: 80, rows: 24 });
    const ids = (await listed()).map((s) => s.sessionId);
    expect(ids).not.toContain(fresh.id);
  });

  it('includes a session once a command has run in it', async () => {
    const used = sessions.create({ cols: 80, rows: 24 });
    expect((await listed()).map((s) => s.sessionId)).not.toContain(used.id);

    sessions.noteCommandStarted(used);

    expect((await listed()).map((s) => s.sessionId)).toContain(used.id);
  });

  it('keeps a session listed after its command finishes', async () => {
    const done = sessions.create({ cols: 80, rows: 24 });
    sessions.noteCommandStarted(done);
    done.commandRunning = false;

    expect((await listed()).map((s) => s.sessionId)).toContain(done.id);
  });

  it('includes a session started for a command from the moment it exists', async () => {
    // Nothing has been typed into it and nothing ever will be, but the command is the entire
    // reason it was spawned and it may still be running.
    const job = sessions.create({ cols: 80, rows: 24, command: ['sleep', '30'] });

    expect((await listed()).map((s) => s.sessionId)).toContain(job.id);
  });
});
