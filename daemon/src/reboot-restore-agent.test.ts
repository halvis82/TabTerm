import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  controlFrame,
  decodeFrame,
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
import { OutputArchive } from './output-archive.js';
import { PluginHost } from './plugin-api.js';
import { RestoreStore } from './restore-store.js';
import { DaemonServer } from './server.js';
import { LocalPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
import { agentInForeground } from './agent-resume.js';

/**
 * A pane that was running an agent, brought back after a reboot.
 *
 * The restore notice already said the shell was new, which is true and, in front of a Claude or
 * Codex transcript, still misleading. The conversation is the thing on the screen and the
 * conversation is what is not running, so that is what has to be named. The one thing this
 * feature must never do is let somebody believe their agent is still working.
 */
const PORT = 7991;
const config: Config = { ...DEFAULTS, port: PORT };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    ws.send(controlFrame({ t: 'auth', v: PROTOCOL_VERSION, role: 'data', token, clientId: 'rra' }));
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
  const sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
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
    new OutputArchive(db),
    new PluginHost(),
  );
  await server.listen();
  return { server, sessions, workspaces };
}

async function stopDaemon(daemon: Daemon): Promise<void> {
  daemon.server.snapshotAll();
  await daemon.server.close();
  await daemon.sessions.shutdown();
}

let daemon: Daemon;
let dir = '';

beforeAll(async () => {
  initLog('error');
  token = initAuth();
  dir = await realpath(await mkdtemp(join(tmpdir(), 'tabterm-rragent-')));
  daemon = await startDaemon();
});

afterAll(async () => {
  await stopDaemon(daemon);
  db.close();
});

describe('a restored pane that had an agent in it', () => {
  it('says the conversation is history, and where to pick it up', async () => {
    const c = await Client.connect();
    c.send({ t: 'create-session', cwd: dir, cols: 80, rows: 24 });
    const created = (await c.waitFor('session-created')) as ControlMessage & {
      sessionId: string;
      workspaceId: string;
    };
    await sleep(400);

    /**
     * Set directly, because starting a real agent CLI in a test is not the thing being tested.
     *
     * The daemon learns this from the foreground process of the pane, which is how a shell
     * somebody typed `claude` into counts as an agent pane just as much as one launched as one.
     */
    const session = daemon.sessions.get(created.sessionId);
    expect(session).toBeDefined();
    session?.vt.write('> summarize the repo\r\nI have read 40 files.\r\n');
    await sleep(150);

    const workspaceId = created.workspaceId;
    c.close();
    await stopDaemon(daemon);

    /**
     * The agent written into the record directly, rather than by running one.
     *
     * The daemon reads it from the foreground process, which the command tracker keeps up to
     * date from the real process table. Setting that field in a test is a race against the next
     * poll, and starting an actual agent CLI would make this a test of whether Claude is
     * installed. Which program counts as an agent is checked on its own, below.
     */
    db.handle
      .prepare('UPDATE pane_snapshots SET agent = ? WHERE workspace_id = ?')
      .run('claude', workspaceId);

    // The machine came back. The processes did not, and the database is all that is left.
    daemon = await startDaemon();
    const c2 = await Client.connect();
    c2.send({ t: 'list-restorable' });
    const offered = (await c2.waitFor('restorable-workspaces')) as unknown as {
      workspaces: RestorableSummary[];
    };
    expect(offered.workspaces.map((w) => w.workspaceId)).toContain(workspaceId);

    c2.send({ t: 'restore-workspace', workspaceId, replayCommands: false, cols: 80, rows: 24 });
    await c2.waitFor('session-created');
    await sleep(700);

    const screens = daemon.sessions.all.map((s) => s.vt.snapshot(0).screen).join('\n');
    // What was there is still there, which is the reason to offer a restore at all.
    expect(screens).toContain('I have read 40 files.');
    // And it is named as history rather than left to look live.
    expect(screens).toContain('claude conversation above is history');
    expect(screens).toContain('not a running session');
    // Somebody is told what to do about it instead of only what is wrong.
    expect(screens).toContain('Resume it from the start screen');
    c2.close();
  }, 30_000);

  it('says the ordinary thing when no agent was running', () => {
    // The specific wording is for the specific case. A plain shell gets the plain sentence, and
    // adding agent language to every restore would make the honest line easy to stop reading.
    expect(agentInForeground('/bin/zsh')).toBeUndefined();
    expect(agentInForeground(undefined)).toBeUndefined();
    expect(agentInForeground('')).toBeUndefined();
  });

  it('counts a pane as an agent by what is running in it, not by how it was opened', () => {
    // A shell somebody typed `claude` into is an agent pane just as much as one launched as one.
    expect(agentInForeground('claude')).toBe('claude');
    expect(agentInForeground('/opt/homebrew/bin/claude')).toBe('claude');
    expect(agentInForeground('/usr/local/bin/codex')).toBe('codex');
    // And something merely named like one is not.
    expect(agentInForeground('claude-helper')).toBeUndefined();
  });
});
