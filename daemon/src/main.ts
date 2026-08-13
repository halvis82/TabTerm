import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { TurnTracker } from './agent-turns.js';
import { LocalPtyBackend } from './pty-backend.js';
import { PtyHostClient } from './pty-host/client.js';
import { HostPtyBackend } from './pty-host/backend.js';
import { HOST_LOCK, HOST_SOCKET } from './pty-host/paths.js';
import { planAdoption, prunePanes } from './adopt.js';
import { readUserSettings } from './user-settings.js';

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
    /**
     * Another daemon is already serving, so this one has nothing to do.
     *
     * It exits **successfully**, which matters: the LaunchAgent is
     * `KeepAlive{SuccessfulExit:false}`, so a non-zero exit means "restart me". A daemon that
     * cannot start because a healthy one already exists is not a failure, and treating it as
     * one produces an infinite restart loop. That is not hypothetical: it ran 18,538 times over
     * six days and wrote 6 MB of the identical line to stderr.
     */
    info('daemon.already-running', { detail: String(e) });
    console.error(String(e));
    process.exit(0);
  }

  initAuth();

  // The manager and the server reference each other, so the event handlers are installed
  // after both exist. SessionManager holds this object by reference.
  const events: SessionEvents = { onExit: () => {}, onStateChange: () => {} };

  /**
   * Where the PTYs live.
   *
   * The host is a separate process that outlives this one, so replacing the daemon does not end
   * anybody's terminal. If it cannot be started, everything still works with the PTYs in this
   * process, and the only thing lost is surviving an update. A TabTerm that runs without that
   * beats one that does not run. See docs/adr/0017.
   */
  const hostClient = new PtyHostClient({
    socketPath: HOST_SOCKET,
    hostScript: hostScriptPath(),
  });
  const usingHost = await hostClient.connect();
  const ptyBackend = usingHost ? new HostPtyBackend(hostClient) : new LocalPtyBackend();
  if (!usingHost) warn('pty-host.falling-back', { detail: 'PTYs will not survive a restart' });

  const sessions = new SessionManager(config, events, ptyBackend);
  // A preference the user set, which has to outlive the daemon that was told about it.
  const storedTimeout = readUserSettings()['keepBackgroundSeconds'];
  if (storedTimeout === null || typeof storedTimeout === 'number') {
    sessions.keepBackgroundSeconds = storedTimeout;
  }
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
    /**
     * Keep the record before the workspace forgets the session.
     *
     * A workspace whose last pane ends is dropped, which is right: there is nothing left to lay
     * out. But a tab may still be open on it, and once the workspace is gone there is nothing to
     * recall, so that tab could only say the session expired and not what happened in it. The
     * recovery row is written first, while the mapping still exists.
     */
    const workspaceBefore = workspaces.findBySession(s.id);
    if (workspaceBefore) {
      launcher.rememberSession({
        id: s.id,
        cwd: s.cwd,
        shell: s.shell,
        workspaceId: workspaceBefore.id,
        ...(s.pendingCommand ? { lastCommand: s.pendingCommand } : {}),
      });
    }

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
      events.onCommand?.(s, command, undefined, durationMs);
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
    archive.end(s.id, exitCode ?? 0);
    plugins.notify({
      type: 'command-end',
      session: {
        sessionId: s.id,
        cwd: s.cwd,
        command,
        ...(exitCode !== undefined ? { exitCode } : {}),
      },
    });
    server.notifySession(s, {
      t: 'command-end',
      sessionId: s.id,
      commandId: String(Date.now()),
      ...(exitCode !== undefined ? { exitCode } : {}),
      completedAt: Date.now(),
      interrupted: exitCode === 130,
    });
    launcher.recordCommand({
      command,
      cwd: s.cwd,
      ...(exitCode !== undefined ? { exitCode } : {}),
      durationMs,
      sessionId: s.id,
    });
    const ws = workspaces.findBySession(s.id);
    // Long enough that you tabbed away from it, which is the only case worth interrupting for.
    server.notifyFinished(
      { kind: 'command', command, durationMs, ...(exitCode !== undefined ? { exitCode } : {}) },
      shortPlace(s.cwd),
      ws ? { workspaceId: ws.id } : undefined,
    );
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

  const turns = new TurnTracker();

  // Agent state arrives over its own loopback endpoint rather than the socket, because hooks
  // are separate processes that cannot hold a WebSocket. Same token, same boundary.
  const agentBridge = new AgentBridge({
    port: config.agentBridgePort,
    verifyToken,
    onEvent: ({ sessionId, state, detail }) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      const previous = session.agentState;
      session.agentState = state;
      server.recordAgentEvent(Date.now());

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

      // A turn, bounded by the hooks that report its ends. See agent-turns.ts.
      const turn = turns.observe(sessionId, state, previous, Date.now());
      if (turn) {
        const where = workspaces.findBySession(sessionId);
        server.notifyFinished(
          { kind: 'agent-turn', durationMs: turn.durationMs, failed: turn.failed },
          shortPlace(session.cwd),
          where ? { workspaceId: where.id } : undefined,
        );
      }
    },
  });
  await agentBridge.listen();

  /**
   * Take over anything that was already running.
   *
   * This is the half of the PTY host that a person actually sees. The host keeping processes
   * alive is invisible if every tab still says the session expired, so the daemon rebuilds its
   * own view from what the host has and what the database remembers, and the tab reconnects to
   * the same terminal it had. See docs/adr/0017.
   */
  if (usingHost) {
    try {
      const live = await ptyBackend.adoptable();
      if (live.length > 0) {
        const plan = planAdoption(live, db, config.shell);
        const adopted = new Set<string>();
        for (const entry of plan.sessions) {
          const session = sessions.adopt({ ...entry, cols: 80, rows: 24 });
          adopted.add(session.id);
        }
        for (const workspace of plan.workspaces) {
          const layout = prunePanes(workspace.layout, adopted);
          if (layout) {
            const now = Date.now();
            workspaces.hydrate({
              id: workspace.id,
              layout,
              pinned: true,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
        // Replay after the sessions exist, so the bytes land in a VT that is listening.
        for (const entry of plan.sessions) {
          await (ptyBackend as HostPtyBackend).replay(entry.sessionId, 0);
        }
        info('adopt.complete', {
          sessions: adopted.size,
          workspaces: plan.workspaces.length,
        });
      }
    } catch (e: unknown) {
      // Adoption is an optimization over "the session expired". Failing it must never stop the
      // daemon from serving, because then a bad row would cost you every terminal.
      warn('adopt.failed', { error: String(e) });
    }
  }

  if (usingHost) {
    /**
     * A new host means every session the old one held is gone.
     *
     * Their processes died with it and cannot be recovered, so the daemon lets go of them
     * rather than holding sessions whose PTYs do not exist. A tab on one then gets the page
     * that says the session expired, which is true, instead of a terminal that never responds.
     */
    hostClient.onReconnect(() => {
      const orphaned = sessions.all;
      warn('pty-host.sessions-lost', { count: orphaned.length });
      for (const session of orphaned) void sessions.kill(session, true);
      hostClient.setBudget(server.scrollbackBytes);
    });

    // Clearing and the memory budget both have to reach the process that holds the buffers.
    server.hostClear = (sessionId) => hostClient.clear(sessionId);
    server.hostBudget = (bytes) => hostClient.setBudget(bytes);
    hostClient.setBudget(server.scrollbackBytes);
  }

  /**
   * The reset path, which needs things only this scope holds: the history directory and the
   * ability to end this process.
   */
  server.setResetHooks({
    history: () => {
      let removed = 0;
      try {
        for (const name of readdirSync(paths.scrollback)) {
          if (!name.endsWith('.log')) continue;
          unlinkSync(join(paths.scrollback, name));
          removed++;
        }
      } catch {
        // Nothing to remove, or a directory somebody already cleared.
      }
      return removed;
    },
    restart: () => {
      /**
       * Replace both processes.
       *
       * The host is stopped first and deliberately: it is the thing that keeps PTYs alive, so a
       * reset that left it running would be a reset that changed nothing. Exiting non-zero is
       * what asks launchd to start a new daemon, since the agent is KeepAlive on failure.
       */
      try {
        if (existsSync(HOST_LOCK)) {
          const pid = Number(readFileSync(HOST_LOCK, 'utf8').trim());
          if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGTERM');
        }
      } catch {
        // A host that is already gone is a host that needs no stopping.
      }
      warn('daemon.reset-restart', {});
      releaseLock();
      process.exit(1);
    },
  });

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

  /** Expired session metadata is only useful for offering a recovery, which ages out fast. */
  const SESSION_META_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

  /** The longest a shutdown may take before it is completed by force. */
  const SHUTDOWN_DEADLINE_MS = 8000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    info('daemon.shutdown', { signal });

    /**
     * A shutdown that cannot finish is worse than an abrupt one.
     *
     * Everything below is bounded on its own, but "bounded on its own" is a claim about code
     * that changes. This is the invariant: the process exits. A daemon that will not is one
     * launchd cannot replace.
     */
    const watchdog = setTimeout(() => {
      warn('daemon.shutdown.forced', { signal, afterMs: SHUTDOWN_DEADLINE_MS });
      releaseLock();
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);
    watchdog.unref();

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
      clearTimeout(watchdog);
      clearInterval(maintenanceTimer);
      releaseLock();
      process.exit(0);
    })();
  };
  /**
   * Housekeeping.
   *
   * Pruning used to run only in the shutdown handler, which meant it ran only on a clean stop.
   * A machine that reboots, a daemon that is SIGKILLed, or one that simply runs for months
   * never pruned anything at all, and the tables it prunes are the ones that grow forever.
   *
   * Hourly, unref'd, and cheap: three indexed deletes. This is a maintenance interval, not a
   * poll for state, which is the distinction docs/11-performance.md draws.
   */
  const maintain = () => {
    try {
      restore.prune(RESTORE_RETENTION_MS);
      archive.prune({ olderThanMs: ARCHIVE_RETENTION_MS, maxTotalBytes: ARCHIVE_MAX_BYTES });
      launcher.pruneSessions(SESSION_META_RETENTION_MS);
    } catch (e) {
      warn('maintenance.failed', { error: String(e) });
    }
  };
  const maintenanceTimer = setInterval(maintain, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();
  // Once at startup too, so a machine that is rebooted daily still prunes.
  maintain();

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  /**
   * An unhandled rejection terminates the process by default, with nothing written down.
   *
   * The daemon is restarted by launchd, so the user sees a blip and the logs say nothing about
   * why. Recording it costs a line and turns an unexplained restart into a diagnosable one.
   */
  process.on('unhandledRejection', (reason) => {
    error('daemon.unhandled-rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (e) => {
    error('daemon.uncaught', { error: String(e), stack: e.stack });
  });
}

void main();

/**
 * The last path segment, which is what a person calls the place they are working in.
 *
 * Home is the exception and is called `~`. Its last segment is the account name, so a
 * notification from the home directory would otherwise be "in <username>", which reads as
 * though it happened to somebody else.
 */
function shortPlace(cwd: string): string | undefined {
  const trimmed = cwd.replace(/\/+$/, '');
  if (trimmed === homedir().replace(/\/+$/, '')) return '~';
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || undefined;
}

/**
 * Where the host executable is.
 *
 * Beside this file, whether that is the staged copy in `~/.local/libexec/tabterm` or a build
 * output in a working tree. Resolved from `import.meta.url` rather than a configured path so an
 * install and a checkout both work without either knowing about the other.
 */
function hostScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'pty-host.mjs'), join(here, 'pty-host.js')]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(here, 'pty-host.js');
}
