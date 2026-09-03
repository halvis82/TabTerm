import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, controlFrame, decodeFrame, type ControlMessage } from '@tabterm/shared';
import { DEFAULTS, type Config } from './config.js';
import { initLog } from './log.js';
import { ProjectIndex } from './project-index.js';
import { OutputArchive } from './output-archive.js';
import { PluginHost } from './plugin-api.js';
import { RestoreStore } from './restore-store.js';
import { ProjectTrust } from './project-trust.js';
import { DaemonServer } from './server.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';
import { initAuth } from './auth.js';
import { WorkspaceStore } from './workspace-store.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';

/**
 * One bad message must not take the daemon down.
 *
 * The daemon holds every terminal on the machine, so a crash here is not a failed request: it is
 * everybody's work ending at once. There is a guard around message handling and it has been
 * there a long time, but nothing had ever thrown anything at it that it did not expect, and a
 * guard nobody has tested is a guard nobody knows the shape of.
 *
 * The point of this file is the assertion at the end of every case: the daemon is still up and
 * still serving a client that speaks properly. What happens to the sender is deliberately not
 * asserted, because closing a connection that sent nonsense is a perfectly good answer and so is
 * an error reply.
 */
// Its own port. Every daemon test binds one, and two files sharing a number fail as a timeout
// in whichever happened to run second, which reads as a bug in the thing being tested.
const PORT = 7992;
const config: Config = { ...DEFAULTS, port: PORT, scrollbackLines: 500 };

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
  const workspaces = new WorkspaceStore();
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

async function connect(clientId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((r, j) => {
    ws.on('open', r);
    ws.on('error', j);
  });
  ws.send(controlFrame({ t: 'auth', v: PROTOCOL_VERSION, role: 'data', token, clientId }));
  return ws;
}

/** Ask something ordinary and wait for the answer, which is the whole proof of life. */
async function stillServes(clientId: string): Promise<boolean> {
  const ws = await connect(clientId);
  const answered = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    ws.on('message', (raw: Buffer) => {
      const frame = decodeFrame(new Uint8Array(raw));
      if (frame.kind !== 'control') return;
      if ((frame.message as { t?: string }).t === 'live-sessions') {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  await sleep(150);
  ws.send(controlFrame({ t: 'list-live-sessions' }));
  const alive = await answered;
  ws.close();
  return alive;
}

function deeplyNested(depth: number): unknown {
  let node: unknown = { type: 'leaf' };
  for (let i = 0; i < depth; i++) node = { type: 'split', children: [node] };
  return node;
}

describe('a client that sends nonsense', () => {
  it('does not take the daemon down, whatever shape the nonsense is', async () => {
    /**
     * Every wrong shape worth trying, and each one is a real mistake rather than an invention.
     *
     * Wrong types where a string is expected, missing required fields, absurd numbers, deep
     * nesting, and ids for things that do not exist. A frontend at the wrong version produces
     * all of these, and so does a half-finished feature.
     */
    const nonsense: unknown[] = [
      {},
      { t: '' },
      { t: 'nope-not-a-message' },
      { t: 42 },
      { t: null },
      { t: 'create-session' },
      { t: 'create-session', cols: 'eighty', rows: null },
      /**
       * The one that took the daemon down, and every terminal on the machine with it.
       *
       * The VT allocates a line object per row, so this asks it for nine quadrillion of them and
       * the process dies of an out-of-memory abort. It was reachable from any page that could
       * talk to the daemon, and nothing had ever sent it because no honest client would.
       */
      { t: 'create-session', cols: -1, rows: Number.MAX_SAFE_INTEGER },
      { t: 'create-session', cols: Number.MAX_SAFE_INTEGER, rows: Number.MAX_SAFE_INTEGER },
      { t: 'attach', sessionId: 'nope', cols: 1e15, rows: 1e15 },
      { t: 'resize', sessionId: 'nope', cols: 1e15, rows: 1e15 },
      { t: 'create-session', cwd: 12345, cols: 80, rows: 24 },
      { t: 'create-session', command: 'not-an-array', cols: 80, rows: 24 },
      { t: 'kill-session' },
      { t: 'kill-session', sessionId: null },
      { t: 'kill-session', sessionId: 'no-such-session' },
      { t: 'kill-session', sessionId: { nested: true } },
      { t: 'resize', sessionId: 'nope', cols: {}, rows: [] },
      { t: 'complete-path' },
      { t: 'complete-path', partial: 999 },
      { t: 'check-folder', path: null },
      { t: 'create-folder', path: '' },
      { t: 'set-background-timeout', seconds: 'forever' },
      { t: 'set-pin', sessionId: 'nope', pinned: 'yes' },
      { t: 'report-open-workspaces', workspaceIds: 'not-a-list' },
      { t: 'recall-workspace', workspaceId: [] },
      { t: 'list-resumable', limit: -5 },
      { t: 'resume-agent', sessionId: '', cwd: null, cols: 0, rows: 0 },
      // Deep enough to matter to anything that walks a message, shallow enough to be legal JSON.
      { t: 'create-layout', layout: deeplyNested(200) },
    ];

    for (const [index, message] of nonsense.entries()) {
      const ws = await connect(`fuzz-${String(index)}`);
      await sleep(60);
      try {
        ws.send(controlFrame(message as ControlMessage));
      } catch {
        // Refusing to encode it here is fine. What matters is the daemon, not this client.
      }
      await sleep(60);
      ws.close();
      // Checked after every single one, so a failure names the message that caused it rather
      // than telling us that something among twenty-six of them did.
      expect(
        await stillServes(`after-${String(index)}`),
        `the daemon stopped serving after ${JSON.stringify(message)}`,
      ).toBe(true);
    }
  }, 90_000);

  it('survives bytes that are not a frame at all', async () => {
    const rubbish: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([255, 255, 255, 255]),
      // A header promising far more than follows, which is the shape that makes a decoder read
      // past the end of what it was given.
      new Uint8Array([1, 255, 255, 255, 255, 1, 2, 3]),
      new TextEncoder().encode('{"t":"auth"'),
      new TextEncoder().encode('not json at all'),
    ];

    for (const [index, bytes] of rubbish.entries()) {
      const ws = await connect(`raw-${String(index)}`);
      await sleep(60);
      ws.send(bytes);
      await sleep(60);
      ws.close();
      expect(
        await stillServes(`after-raw-${String(index)}`),
        `the daemon stopped serving after raw bytes ${String(index)}`,
      ).toBe(true);
    }
  }, 40_000);
});
