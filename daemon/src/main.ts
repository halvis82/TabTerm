import { mkdirSync } from 'node:fs';
import { PROTOCOL_VERSION, VERSION } from '@tabterm/shared';
import { initAuth, verifyToken } from './auth.js';
import { AgentBridge } from './agent-bridge.js';
import { loadConfig, paths } from './config.js';
import { acquireLock } from './lockfile.js';
import { error, info, initLog, warn } from './log.js';
import { DaemonServer } from './server.js';
import { SessionManager, type SessionEvents } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
import { Database } from './database.js';
import { LauncherData } from './launcher-data.js';
import { ProjectIndex } from './project-index.js';
import { RestoreStore } from './restore-store.js';
import { OutputArchive } from './output-archive.js';
import { PluginHost } from './plugin-api.js';
import { loadPlugins } from './plugin-loader.js';
import { CommandTracker } from './command-tracker.js';
import { ProjectTrust } from './project-trust.js';

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
  const projects = new ProjectIndex();
  launcher.useProjectIndex(projects);
  const trust = new ProjectTrust(db);
  const restore = new RestoreStore(db);
  // Off unless the config says otherwise. See docs/03-data-model.md.
  const archive = new OutputArchive(db, config.archiveOutput);
  // Loaded from ~/.config/tabterm/plugins, which is trusted because you put files there
  // deliberately. A project directory never is. See ADR-0013 and docs/05-security.md §5.
  const plugins = new PluginHost();
  await loadPlugins(plugins);
  // Reap policy must know whether a session is a pane in a workspace, since workspaces are
  // pinned by default and their panes are never reaped on a timer. See ADR-0012.
  sessions.isInWorkspace = (sessionId) => workspaces.findBySession(sessionId) !== undefined;

  const server = new DaemonServer(
    config,
    sessions,
    workspaces,
    launcher,
    trust,
    projects,
    restore,
    archive,
    plugins,
  );

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
    archive.abandon(s.id);
    tracker.remove(s.id);
    // A pane whose process ended stops being a pane, so a shell you typed `exit` into takes
    // its pane with it. A pane that was given a command is different: its output is the
    // reason it existed, and closing it the instant the command finishes would throw away
    // exactly what the user was waiting for. Those stay until they are closed deliberately.
    const surviving = s.command?.length ? undefined : workspaces.forgetSession(s.id);
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
  events.onServerDetected = (s, port) => {
    server.notifySession(s, { t: 'server-detected', sessionId: s.id, port });
    // Low priority, so it never becomes a desktop notification. Starting a dev server is not
    // an event that should interrupt anyone; the offer belongs in the tab that started it.
    server.notify(
      'low',
      `Server on port ${String(port)}`,
      `${s.titleFields.process ?? 'A process'} is listening on ${String(port)}.`,
    );
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
  events.onCreated = (s) => tracker.add(s.id, s.pid);
  events.onOutput = (s, chunk) => archive.write(s.id, chunk);
  events.onInputWritten = (s, data) => tracker.onInput(s.id, data);
  events.onIntegrationDetected = (s) => tracker.markIntegrated(s.id);
  /**
   * Command detection for shells with no integration installed.
   *
   * Feeds the same events the OSC 133 path does, so history, timing, pane status, and server
   * detection all work with nothing added to a dotfile. It stands down permanently on any
   * session that turns out to have the real thing. See docs/08-shell-integration.md.
   */
  const tracker = new CommandTracker({
    onStart: (sessionId, command, startedAt) => {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.commandRunning = true;
      s.commandStartedAt = startedAt;
      s.pendingCommand = command;
      // The title says what is running, the same as the integrated path does. Without this a
      // tab running a build still reads "zsh", which is the least useful thing it could say.
      const program = command.trim().split(/\s+/)[0]?.split('/').pop();
      if (program) s.titleFields.process = program;
      events.onCommandStarted?.(s, command, startedAt);
      events.onTitle?.(s);
      sessions.noteCommandStarted(s);
    },
    onEnd: (sessionId, command, durationMs) => {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.commandRunning = false;
      delete s.titleFields.process;
      // The OS does not report an exit code for a process that is already gone, so this records
      // the command without claiming to know how it ended. A wrong exit code would be worse
      // than an absent one: `exit:fail` has to mean something.
      events.onCommand?.(s, command, 0, durationMs);
      events.onTitle?.(s);
    },
  });

  events.onCommandStarted = (s, command, startedAt) => {
    archive.begin(s.id, command, s.cwd);
    plugins.notify({ type: 'command-start', session: { sessionId: s.id, cwd: s.cwd, command } });
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
    archive.end(s.id, exitCode);
    plugins.notify({
      type: 'command-end',
      session: { sessionId: s.id, cwd: s.cwd, command, exitCode },
    });
    server.notifySession(s, {
      t: 'command-end',
      sessionId: s.id,
      commandId: String(Date.now()),
      exitCode,
      completedAt: Date.now(),
      interrupted: exitCode === 130,
    });
    launcher.recordCommand({ command, cwd: s.cwd, exitCode, durationMs, sessionId: s.id });
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

  /** How long a workspace stays restorable. Long enough to survive a weekend away. */
  const RESTORE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

  /**
   * Archive retention: both a window and a ceiling.
   *
   * Either limit alone has a case it handles badly. Age alone lets one noisy afternoon fill the
   * disk; size alone throws away a quiet week that fit comfortably.
   */
  const ARCHIVE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
  const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('daemon.shutdown', { signal });
    void (async () => {
      await agentBridge.close();
      // Capture every workspace before anything closes. A machine restarting is the case reboot
      // restore exists for, and this is the last moment the screens are still readable.
      try {
        server.snapshotAll();
        restore.prune(RESTORE_RETENTION_MS);
        archive.prune({ olderThanMs: ARCHIVE_RETENTION_MS, maxTotalBytes: ARCHIVE_MAX_BYTES });
      } catch (e) {
        warn('restore.snapshot.failed', { error: String(e) });
      }
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
