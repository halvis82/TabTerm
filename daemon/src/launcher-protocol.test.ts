import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  sessions = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
  launcher = new LauncherData(new Database(':memory:'));
  server = new DaemonServer(
    config,
    sessions,
    new WorkspaceStore(),
    launcher,
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
    /**
     * Real directories, because the launcher no longer offers folders that are gone.
     *
     * The repository itself, which exists wherever these tests run and is not one of the
     * locations excluded from recent folders.
     */
    const alpha = join(process.cwd(), 'docs');
    const beta = join(process.cwd(), 'daemon');
    launcher.recordDir(alpha);
    launcher.recordDir(beta);
    launcher.recordDir(beta);

    const c = await Client.connect();
    c.send({ t: 'list-launcher' });
    const msg = (await c.waitFor('launcher-state')) as unknown as { state: LauncherState };
    const paths = msg.state.recentDirs.map((d) => d.path);

    expect(paths).toContain(alpha);
    expect(paths).toContain(beta);
    // Visited twice, so it outranks the one visited once.
    expect(paths.indexOf(beta)).toBeLessThan(paths.indexOf(alpha));
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

describe('the folder box asks the daemon whether a folder is there', () => {
  /**
   * A page cannot look at the disk, so the answer has to come from here, and it has to be
   * matched to the text that was asked about. Somebody typing a path produces a check per
   * keystroke, and an answer to a prefix arriving after a longer prefix was typed would
   * otherwise be shown against the wrong text.
   */
  const scratch = mkdtempSync(join(tmpdir(), 'tabterm-folder-'));

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('answers about a folder that is there', async () => {
    const c = await Client.connect();
    c.send({ t: 'check-folder', path: scratch });
    const msg = (await c.waitFor('folder-checked')) as unknown as {
      path: string;
      exists: boolean;
      isFile?: boolean;
    };

    expect(msg.exists).toBe(true);
    // Only sent when it is one, since "there but a file" is the only case worth a word for.
    expect(msg.isFile).toBeUndefined();
    // Echoed exactly, which is what lets a stale answer be recognized.
    expect(msg.path).toBe(scratch);
    c.close();
  });

  it('answers about one that is not, without treating it as a failure', async () => {
    const c = await Client.connect();
    const missing = join(scratch, 'not-here');
    c.send({ t: 'check-folder', path: missing });
    const msg = (await c.waitFor('folder-checked')) as unknown as {
      exists: boolean;
      error?: string;
    };

    expect(msg.exists).toBe(false);
    expect(msg.error).toBeUndefined();
    c.close();
  });

  it('tells a file apart from a folder', async () => {
    // Both are "something is there", and only one of them can be opened as a working directory.
    const file = join(scratch, 'a-file');
    writeFileSync(file, 'x');
    const c = await Client.connect();
    c.send({ t: 'check-folder', path: file });
    const msg = (await c.waitFor('folder-checked')) as unknown as {
      exists: boolean;
      isFile?: boolean;
    };

    expect(msg.exists).toBe(false);
    expect(msg.isFile).toBe(true);
    c.close();
  });

  it('creates one that is missing, and says it is there afterwards', async () => {
    const c = await Client.connect();
    const wanted = join(scratch, 'made', 'nested');
    c.send({ t: 'create-folder', path: wanted });
    const msg = (await c.waitFor('folder-checked')) as unknown as { exists: boolean };

    // Nested, because somebody typing a path types the whole path rather than one level of it.
    expect(msg.exists).toBe(true);
    c.close();
  });

  it('reports why it could not create one, rather than reporting nothing', async () => {
    const c = await Client.connect();
    c.send({ t: 'create-folder', path: '/tabterm-cannot-write-here/x' });
    const msg = (await c.waitFor('folder-checked')) as unknown as {
      exists: boolean;
      error?: string;
    };

    expect(msg.exists).toBe(false);
    expect(msg.error ?? '').not.toBe('');
    c.close();
  });
});
