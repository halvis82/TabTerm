import { mkdirSync } from 'node:fs';
import { PROTOCOL_VERSION, VERSION } from '@tabterm/shared';
import { initAuth, verifyToken } from './auth.js';
import { AgentBridge } from './agent-bridge.js';
import { loadConfig, paths } from './config.js';
import { acquireLock } from './lockfile.js';
import { error, info, initLog } from './log.js';
import { DaemonServer } from './server.js';
import { SessionManager, type SessionEvents } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';

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
  const workspaces = new WorkspaceStore();
  const db = new Database();
  const launcher = new LauncherData(db);
  // Reap policy must know whether a session is a pane in a workspace, since workspaces are
  // pinned by default and their panes are never reaped on a timer. See ADR-0012.
  sessions.isInWorkspace = (sessionId) => workspaces.findBySession(sessionId) !== undefined;

  const server = new DaemonServer(config, sessions, workspaces, launcher);

  events.onExit = (s) => {
    // A pane whose process failed is worth surfacing: the tab may be hidden, and a silent
    // failure is one the user finds much later. A clean exit is not worth interrupting for.
    if ((s.exitCode ?? 0) !== 0) {
      const where = workspaces.findBySession(s.id);
      server.notify(
        'important',
        'Process failed',
        `${s.titleFields.cwd ?? s.cwd} exited with ${String(s.exitCode ?? 0)}`,
        where ? { workspaceId: where.id } : undefined,
      );
    }
    // A pane whose process ended stops being a pane. The layout closes over it.
    const surviving = workspaces.forgetSession(s.id);
    if (surviving) {
      server.broadcast({
        t: 'workspace-updated',
        workspaceId: surviving.id,
        layout: surviving.layout,
      });
    }
    server.notifySession(s, {
      t: 'session-exited',
      sessionId: s.id,
      exitCode: s.exitCode ?? 0,
      ...(s.signal !== undefined ? { signal: String(s.signal) } : {}),
    });
  };
  events.onCwd = (s) => {
    launcher.recordDir(s.cwd);
    const ws = workspaces.findBySession(s.id);
    launcher.rememberSession({
      id: s.id,
      cwd: s.cwd,
      shell: s.shell,
      ...(ws ? { workspaceId: ws.id } : {}),
      ...(s.command ? { command: s.command } : {}),
    });
    server.notifySession(s, { t: 'cwd', sessionId: s.id, cwd: s.cwd });
  };
  events.onCommandStarted = (s, command, startedAt) => {
    server.notifySession(s, {
      t: 'command-start',
      sessionId: s.id,
      commandId: String(startedAt),
      command,
      cwd: s.cwd,
      startedAt,
    });
  };
  events.onCommand = (s, command, exitCode, durationMs) => {
    server.notifySession(s, {
      t: 'command-end',
      sessionId: s.id,
      commandId: String(Date.now()),
      exitCode,
      completedAt: Date.now(),
      interrupted: exitCode === 130,
    });
    launcher.recordCommand({ command, cwd: s.cwd, exitCode, durationMs });
    const ws = workspaces.findBySession(s.id);
    launcher.rememberSession({
      id: s.id,
      cwd: s.cwd,
      shell: s.shell,
      lastCommand: command,
      ...(ws ? { workspaceId: ws.id } : {}),
    });
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

  // Agent state arrives over its own loopback endpoint rather than the socket, because hooks
  // are separate processes that cannot hold a WebSocket. Same token, same boundary.
  const agentBridge = new AgentBridge({
    port: config.agentBridgePort,
    verifyToken,
    onEvent: ({ sessionId, state, detail }) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.agentState = state;

      server.notifySession(session, {
        t: 'agent-state',
        sessionId,
        state,
        ...(detail ? { detail } : {}),
      });

      // Needing a person is the whole reason this exists, and it must arrive even with every
      // terminal tab hidden. See docs/09-agent-integration.md.
      if (state === 'approval' || state === 'waiting') {
        const where = workspaces.findBySession(sessionId);
        server.notify(
          state === 'approval' ? 'critical' : 'important',
          state === 'approval' ? 'Agent needs approval' : 'Agent is waiting for you',
          detail ?? session.cwd,
          where ? { workspaceId: where.id } : undefined,
        );
      }
    },
  });
  await agentBridge.listen();

  await server.listen();
  info('daemon.ready', { version: VERSION, protocol: PROTOCOL_VERSION, pid: process.pid });
  console.error(`tabtermd ${VERSION} listening on 127.0.0.1:${String(config.port)}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('daemon.shutdown', { signal });
    void (async () => {
      await agentBridge.close();
      await server.close();
      launcher.flush();
      db.close();
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
