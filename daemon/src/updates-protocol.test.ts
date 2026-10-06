import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { controlFrame, decodeFrame, type ControlMessage } from '@tabterm/shared';
import { UpdateManager } from '../../scripts/updater/manager.mjs';
import { initAuth } from './auth.js';
import { DEFAULTS } from './config.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { ProjectIndex } from './project-index.js';
import { OutputArchive } from './output-archive.js';
import { PluginHost } from './plugin-api.js';
import { StatsStore } from './stats-store.js';
import { RestoreStore } from './restore-store.js';
import { ProjectTrust } from './project-trust.js';
import { DaemonServer } from './server.js';
import { NoPtyBackend } from './pty-backend.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
const home = mkdtempSync(join(tmpdir(), 'tabterm-update-protocol-'));
const db = new Database(':memory:');
const config = { ...DEFAULTS, port: 0 };
const sessions = new SessionManager(
  config,
  { onExit: () => {}, onStateChange: () => {} },
  new NoPtyBackend(),
);
const server = new DaemonServer(
  config,
  sessions,
  new WorkspaceStore(),
  new LauncherData(db),
  new ProjectTrust(db),
  new ProjectIndex(),
  new RestoreStore(db),
  new StatsStore(db),
  new OutputArchive(db),
  new PluginHost(),
);
let token: string, port: number;
beforeAll(async () => {
  token = initAuth();
  server.updates = new UpdateManager({
    home,
    version: '1.1.0',
    enabled: false,
    changed: (status) => server.broadcastAll({ t: 'companion-update', status }),
  });
  port = await server.listen();
});
afterAll(async () => {
  server.updates?.stop();
  await server.close();
  await sessions.shutdown();
  db.close();
  rmSync(home, { recursive: true, force: true });
});
async function request(message: ControlMessage, authenticated = true): Promise<ControlMessage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(Error('no response'));
    }, 3000);
    ws.on('open', () =>
      ws.send(
        controlFrame(
          authenticated
            ? { t: 'auth', v: 1, role: 'control', token, clientId: 'update-test' }
            : message,
        ),
      ),
    );
    ws.on('message', (bytes: Buffer) => {
      const frame = decodeFrame(bytes);
      if (frame.kind !== 'control') return;
      if (frame.message.t === 'auth-ok') {
        ws.send(controlFrame(message));
        return;
      }
      clearTimeout(timer);
      ws.close();
      resolve(frame.message);
    });
    ws.on('error', reject);
  });
}
it('refuses update commands before authentication', async () => {
  const code = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('socket did not close'));
    }, 3000);
    ws.on('open', () => ws.send(controlFrame({ t: 'install-companion-update' })));
    ws.on('close', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    ws.on('error', reject);
  });
  expect(code).toBe(1008);
  expect(server.updates?.snapshot().phase).toBe('idle');
});
it('reports defaults through the authenticated transport', async () => {
  const value = await request({ t: 'get-companion-update' });
  expect(value.t).toBe('companion-update');
  if (value.t === 'companion-update') {
    expect(value.status.installedVersion).toBe('1.1.0');
    expect(value.status.automaticChecks).toBe(true);
    expect(value.status.canInstall).toBe(false);
  }
});
it('persists boolean preferences without enabling a development installation', async () => {
  const value = await request({
    t: 'set-companion-updates',
    automaticChecks: false,
    automaticInstall: false,
  });
  expect(value.t).toBe('companion-update');
  const reopened = new UpdateManager({ home, version: '1.1.0' });
  expect(reopened.snapshot().automaticInstall).toBe(false);
});
it('provides authenticated health and a bounded activation pause', async () => {
  const value = await request({ t: 'prepare-companion-update' });
  expect(value.t).toBe('update-health');
  expect(sessions.updatePausedUntil).toBeGreaterThan(Date.now());
  expect(() => sessions.create({ cols: 80, rows: 24 })).toThrow('updating');
  await request({ t: 'finish-companion-update' });
  expect(sessions.updatePausedUntil).toBe(0);
});
