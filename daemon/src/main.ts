import { mkdirSync } from 'node:fs';
import { PROTOCOL_VERSION, VERSION } from '@tabterm/shared';
import { initAuth } from './auth.js';
import { loadConfig, paths } from './config.js';
import { acquireLock } from './lockfile.js';
import { error, info, initLog } from './log.js';
import { DaemonServer } from './server.js';
import { SessionManager, type SessionEvents } from './session-manager.js';

/**
 * The daemon owns every PTY. No terminal process is ever tied to a Chrome page's lifetime,
 * which is what lets tabs close, move, merge, and reopen without killing anything.
 * See docs/01-architecture.md.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  mkdirSync(paths.scrollback, { recursive: true, mode: 0o700 });
  initLog(config.logLevel);

  let releaseLock: () => void;
  try {
    releaseLock = acquireLock();
  } catch (e) {
    error('daemon.already-running', { error: String(e) });
    console.error(String(e));
    process.exit(1);
  }

  initAuth();

  // The manager and the server reference each other, so the event handlers are installed
  // after both exist. SessionManager holds this object by reference.
  const events: SessionEvents = { onExit: () => {}, onStateChange: () => {} };
  const sessions = new SessionManager(config, events);
  const server = new DaemonServer(config, sessions);

  events.onExit = (s) => {
    server.notifySession(s, {
      t: 'session-exited',
      sessionId: s.id,
      exitCode: s.exitCode ?? 0,
      ...(s.signal !== undefined ? { signal: String(s.signal) } : {}),
    });
  };
  events.onCwd = (s) => {
    server.notifySession(s, { t: 'cwd', sessionId: s.id, cwd: s.cwd });
  };
  events.onTitle = (s) => {
    server.notifySession(s, { t: 'title', sessionId: s.id, fields: s.titleFields });
  };
  events.onStateChange = (s) => {
    server.broadcast({
      t: 'process-state',
      sessionId: s.id,
      state: s.state === 'exited' ? 'exited' : 'idle',
    });
  };

  await server.listen();
  info('daemon.ready', { version: VERSION, protocol: PROTOCOL_VERSION, pid: process.pid });
  console.error(`tabtermd ${VERSION} listening on 127.0.0.1:${String(config.port)}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('daemon.shutdown', { signal });
    void (async () => {
      await server.close();
      await sessions.shutdown();
      releaseLock();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    error('daemon.uncaught', { error: String(e), stack: e.stack });
  });
}

void main();
