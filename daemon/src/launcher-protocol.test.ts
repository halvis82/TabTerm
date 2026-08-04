import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  controlFrame,
  decodeFrame,
  type ControlMessage,
  type LauncherState,
} from '@tabterm/shared';
import { initAuth } from './auth.js';
import { DEFAULTS, type Config } from './config.js';
import { LauncherData } from './launcher-data.js';
import { initLog } from './log.js';
import { DaemonServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * Exercises the launcher protocol without spawning a single terminal.
 *
 * Everything here is read or write of stored data, so no PTY is created and nothing appears on
 * screen. Layout creation, which does spawn shells, is deliberately not exercised here.
 */
const PORT = 7998;
const config: Config = { ...DEFAULTS, port: PORT };

let server: DaemonServer;
let sessions: SessionManager;
let launcher: LauncherData;
let token: string;

beforeAll(async () => {
  initLog('error');
  token = initAuth();
  sessions = new SessionManager(config, { onExit: () => {}, onStateChange: () => {} });
  launcher = new LauncherData();
  server = new DaemonServer(config, sessions, new WorkspaceStore(), launcher);
  await server.listen();
});

afterAll(async () => {
  await server.close();
  await sessions.shutdown();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  readonly ws: WebSocket;
  readonly seen: ControlMessage[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
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
    ws.send(controlFrame({ t: 'auth', v: PROTOCOL_VERSION, role: 'data', token, clientId: 'lp' }));
    await c.waitFor('auth-ok');
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

  forget(): void {
    this.seen.length = 0;
  }
  close(): void {
    this.ws.close();
  }
}

describe('launcher protocol', () => {
  it('serves launcher state with an empty plugin list', async () => {
    const c = await Client.connect();
    c.send({ t: 'list-launcher' });
    const msg = (await c.waitFor('launcher-state')) as unknown as { state: LauncherState };

    // No plugins exist yet, and an empty list is what lets the UI render no plugin section.
    expect(msg.state.plugins).toEqual([]);
    expect(Array.isArray(msg.state.recentDirs)).toBe(true);
    expect(msg.state.home.startsWith('/')).toBe(true);
    c.close();
  });

  it('records directories and offers them back, most useful first', async () => {
    launcher.recordDir('/Users/someone/Projects/alpha');
    launcher.recordDir('/Users/someone/Projects/beta');
    launcher.recordDir('/Users/someone/Projects/beta');

    const c = await Client.connect();
    c.send({ t: 'list-launcher' });
    const msg = (await c.waitFor('launcher-state')) as unknown as { state: LauncherState };
    const paths = msg.state.recentDirs.map((d) => d.path);

    expect(paths).toContain('/Users/someone/Projects/alpha');
    expect(paths).toContain('/Users/someone/Projects/beta');
    // Visited twice, so it outranks the one visited once.
    expect(paths.indexOf('/Users/someone/Projects/beta')).toBeLessThan(
      paths.indexOf('/Users/someone/Projects/alpha'),
    );
    c.close();
  });

  it('saves, lists, and deletes a saved command', async () => {
    const c = await Client.connect();
    c.send({ t: 'save-item', title: 'restart backend', body: 'npm run backend:restart' });
    const saved = (await c.waitFor('saved-updated')) as unknown as {
      saved: { id: string; body: string }[];
    };
    const hit = saved.saved.find((s) => s.body === 'npm run backend:restart');
    expect(hit).toBeTruthy();

    c.forget();
    c.send({ t: 'delete-saved', id: hit?.id ?? '' });
    const after = (await c.waitFor('saved-updated')) as unknown as { saved: { id: string }[] };
    expect(after.saved.find((s) => s.id === hit?.id)).toBeUndefined();
    c.close();
  });

  it('returns history filtered by a fuzzy query', async () => {
    launcher.recordCommand({ command: 'git checkout main', cwd: '/tmp/x' });
    launcher.recordCommand({ command: 'npm run build', cwd: '/tmp/x' });

    const c = await Client.connect();
    c.send({ t: 'list-history', query: 'gco', limit: 50 });
    const page = (await c.waitFor('history-page')) as unknown as { entries: { command: string }[] };
    expect(page.entries.some((e) => e.command === 'git checkout main')).toBe(true);
    expect(page.entries.some((e) => e.command === 'npm run build')).toBe(false);
    c.close();
  });

  it('never records a command that carries a credential', async () => {
    launcher.recordCommand({ command: 'export GITHUB_TOKEN=ghp_secret', cwd: '/tmp/x' });
    launcher.recordCommand({ command: ' hidden-by-leading-space', cwd: '/tmp/x' });

    const c = await Client.connect();
    c.send({ t: 'list-history', query: '', limit: 500 });
    const page = (await c.waitFor('history-page')) as unknown as { entries: { command: string }[] };
    const all = page.entries.map((e) => e.command).join('\n');
    expect(all).not.toContain('ghp_secret');
    expect(all).not.toContain('hidden-by-leading-space');
    c.close();
  });

  it('clears history on request', async () => {
    launcher.recordCommand({ command: 'echo temporary', cwd: '/tmp/x' });
    const c = await Client.connect();
    c.send({ t: 'clear-history' });
    await c.waitFor('history-page');

    c.forget();
    c.send({ t: 'list-history', query: '', limit: 50 });
    const page = (await c.waitFor('history-page')) as unknown as { entries: unknown[] };
    expect(page.entries).toHaveLength(0);
    c.close();
  });
});
