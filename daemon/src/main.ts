import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, VERSION, paneCount } from '@tabterm/shared';
import { initAuth, verifyToken } from './auth.js';
import { AgentBridge } from './agent-bridge.js';
import { loadConfig, paths, ignoredConfigFields } from './config.js';
import { acquireLock } from './lockfile.js';
import { debug, error, info, initLog, warn } from './log.js';
import { isAFailureWorthSaying } from './notify-policy.js';
import { clampTimeout, DaemonServer } from './server.js';
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
import { AttentionNotices } from './attention-notices.js';
import { alreadyAsked, askForFolders } from './ask-for-folders.js';
import { LocalPtyBackend, NoPtyBackend } from './pty-backend.js';
import { PtyHostClient } from './pty-host/client.js';
import { HostPtyBackend } from './pty-host/backend.js';
import { HOST_LOCK, HOST_POINTER, HOST_SOCKET } from './pty-host/paths.js';

/** The shortest the settings panel will offer. Anything under it was never chosen by a person. */
import { decideReconnect } from './host-reconnect.js';
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
  // A hand edited config.json should not be able to destabilise anything, so a field that
  // cannot be used is dropped and named rather than taken at face value. See `usableFields`.
  for (const field of ignoredConfigFields) warn('config.field-ignored', { field });

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
  /**
   * Where the host ended up, written down before we try to reach it.
   *
   * The socket is not always in the state directory: a unix socket path is capped at about a
   * hundred bytes, so a deep enough home pushes it into the temporary directory instead. Writing
   * the answer down means nothing else has to know the rule.
   */
  try {
    mkdirSync(dirname(HOST_POINTER), { recursive: true, mode: 0o700 });
    writeFileSync(HOST_POINTER, `${HOST_SOCKET}\n${HOST_LOCK}\n`, { mode: 0o600 });
  } catch {
    // A pointer that could not be written is a debugging inconvenience, not a reason to stop.
  }
  const usingHost = await hostClient.connect();
  /**
   * No durable host means no terminals, unless somebody has asked for that in so many words.
   *
   * The fallback used to be silent, on the reasoning that TabTerm without restart persistence
   * beats no TabTerm. For this product that reasoning is wrong. `LocalPtyBackend` spawns
   * terminals as children of the daemon, so every one of them dies when the daemon does, and the
   * daemon is restarted by an ordinary update. A person who opened a terminal during a window
   * where the host had not come up would lose it to a routine upgrade, with nothing anywhere
   * having said so.
   *
   * A terminal product whose whole promise is that processes outlive the interface has to fail
   * closed when the thing that keeps that promise is unavailable. The daemon still starts, still
   * serves the interface, and still says what is wrong; it declines to hand anybody a terminal it
   * cannot keep.
   *
   * `TABTERM_ALLOW_LOCAL_PTY=1` brings the old behavior back for development, loudly.
   */
  const allowLocal = process.env['TABTERM_ALLOW_LOCAL_PTY'] === '1';
  if (!usingHost && !allowLocal) {
    error('pty-host.unavailable', {
      detail:
        'the durable PTY host could not be started, so no terminal can be created: one made now ' +
        'would be owned by this process and would end with it',
    });
  } else if (!usingHost) {
    warn('pty-host.local-fallback', {
      detail: 'TABTERM_ALLOW_LOCAL_PTY is set. PTYs are children of this daemon and die with it',
    });
  }
  const ptyBackend = usingHost
    ? new HostPtyBackend(hostClient)
    : allowLocal
      ? new LocalPtyBackend()
      : new NoPtyBackend();

  const sessions = new SessionManager(config, events, ptyBackend);
  /**
   * A preference the user set, which has to outlive the daemon that was told about it.
   *
   * `null` means keep forever and is a real choice. A number below the shortest the settings
   * panel offers is not: nobody could have picked it there, so it came from something else
   * clamping a bad value, and it is ignored in favour of the default. One machine had sixty
   * seconds stored this way and showed "1 minutes" in a picker whose shortest option is five.
   */
  const storedTimeout = readUserSettings()['keepBackgroundSeconds'];
  if (storedTimeout === null) {
    sessions.keepBackgroundSeconds = null;
  } else if (typeof storedTimeout === 'number') {
    /**
     * Clamped, not discarded, and by the same rule that let it be stored.
     *
     * Reading with a stricter rule than writing is how a setting stops being a setting: a value
     * the daemon accepted and wrote down was thrown away on the next start in favour of the
     * default, and the only trace was one log line. A file written by an older build can still
     * hold an out-of-range number, so it is brought into range rather than believed or ignored.
     */
    sessions.keepBackgroundSeconds = clampTimeout(storedTimeout);
  }
  /**
   * Said out loud, because a setting that will not stay is reported about the picker and answered
   * from the log, and until this existed the log had nothing to say about it. What was on disk,
   * and what the daemon decided to run with, which are not always the same: a value below the
   * shortest the panel offers is ignored in favour of the default, and silently.
   */
  info('background-timeout.loaded', {
    stored: typeof storedTimeout === 'number' ? storedTimeout : JSON.stringify(storedTimeout),
    using: String(sessions.keepBackgroundSeconds),
  });
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
  sessions.panesInItsWorkspace = (sessionId) => {
    const workspace = workspaces.findBySession(sessionId);
    return workspace ? paneCount(workspace.layout) : 0;
  };
  // And which workspace, so a report of the tabs Chrome has open can be matched to sessions.
  sessions.setWorkspaceLookup((sessionId) => workspaces.findBySession(sessionId)?.id);

  /**
   * Provenance and the background clock, kept across daemon restarts.
   *
   * Both are read back before anything is adopted. Without the first, every session adopted across
   * a restart is unattributable: no browser in this daemon's lifetime has reported its workspace or
   * asked for it to be created, so nothing can authorise the timeout somebody chose and the session
   * lives for ever. Without the second, every daemon update quietly hands each waiting session a
   * fresh countdown.
   */
  sessions.rememberOwner = (workspaceId, profile) => restore.noteOwner(workspaceId, profile);
  sessions.rememberBackgroundSince = (workspaceId, at) =>
    restore.noteBackgroundSince(workspaceId, at);
  sessions.restoreProvenance(restore.provenance());

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
  /**
   * How long a closed pane may still be brought back, which only the server knows.
   *
   * Wired after construction because the two point at each other: the policy asks the server,
   * and the server holds the sessions the policy is about.
   */
  sessions.undoWindowLeft = (sessionId) => server.undoWindowLeft(sessionId);

  events.onExit = (s) => {
    /**
     * A pane whose process failed is worth surfacing: the tab may be hidden, and a silent
     * failure is one the user finds much later. A clean exit is not worth interrupting for.
     *
     * Two things are not failures, and both were being reported as one.
     *
     * A session TabTerm ended itself exits non-zero because that is what a shell does when it is
     * sent a hangup. Every "Process failed" notification on this machine in a day was TabTerm
     * reaping an unused session and then telling the user their process had failed. Nothing
     * failed, and nothing of theirs was even involved.
     *
     * And somebody who has turned notifications off has turned this off too. It went out
     * regardless of the policy, which is how a setting stops being believed.
     */
    if (isAFailureWorthSaying(s, server.notifyPolicy)) {
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
    attention.forget(s.id);
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

    /**
     * A pane that ran a declared command keeps its pane, **unless somebody ended it**.
     *
     * Its output is the reason it existed, so closing it the instant the command finishes would
     * throw away exactly what was being waited for. A kill is not that: a person chose to end
     * this terminal, and a pane left holding a dead one is what "kill session doesn't close the
     * pane" was.
     */
    const keepsItsPane = s.command?.length && s.endedByRequest !== true;
    const surviving = keepsItsPane ? undefined : workspaces.forgetSession(s.id);
    // One fewer thing to come back to, which every start screen is showing a list of.
    server.launcherChanged();
    if (surviving) {
      /**
       * Sent to the tabs showing it, which `broadcast` does not do.
       *
       * `broadcast` reaches the control role only, so this announcement went exclusively to the
       * service worker: every terminal page kept the pane whose process had just ended. A pane
       * holding a dead terminal looks exactly like a live one and swallows everything typed into
       * it, which is what "i can't close or kill a session from the right-click menu" and "after
       * closing an agent I can't always type commands again" both looked like from outside.
       */
      server.announceLayout(surviving.id);
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
  /**
   * Everybody attached is told what size the terminal is really running at.
   *
   * One PTY has one size, and with several views attached it is the smallest of them. A view
   * that goes on rendering at its own size is drawing into columns the shell does not know
   * exist. It was never told, so it could not do anything else.
   */
  events.onResized = (s, cols, rows) => {
    server.notifySession(s, { t: 'session-size', sessionId: s.id, cols, rows });
  };

  events.onCwd = (s) => {
    if (launcher.recordDir(s.cwd)) server.launcherChanged();
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
      sessions.noteCommandStarted(s, command);
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
    /**
     * A command that has finished has printed whatever it was going to print.
     *
     * Which is the moment a shell becomes a session worth offering: the running list asks what is
     * on the screen, not only what was once started, so nudging at the **start** of a command
     * rebuilds the list a moment too early and finds it still empty.
     */
    server.launcherChanged();
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
  const attention = new AttentionNotices();

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
      // Logged, because until this existed the entire path from a hook to a notification was
      // invisible and a report of it misbehaving had nothing behind it to look at.
      debug('agent.state', { sessionId, from: previous ?? 'none', to: state });

      server.notifySession(session, {
        t: 'agent-state',
        sessionId,
        state,
        ...(detail ? { detail } : {}),
      });

      /**
       * Needing a person is the whole reason this exists, and it must arrive even with every
       * terminal tab hidden. See docs/09-agent-integration.md.
       *
       * Once per entering the state, not once per event that reports it. See
       * `attention-notices.ts` for what that distinction cost.
       */
      if (attention.shouldRaise(sessionId, state, previous, Date.now())) {
        const where = workspaces.findBySession(sessionId);
        info('agent.attention', { sessionId, state });
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
          /**
           * Adopted at the size it is really running at, not at eighty by twenty-four.
           *
           * The screen is rebuilt by replaying the host's output into a fresh emulator, and an
           * emulator of the wrong width wraps every line in the wrong place. Every restart used
           * to rebuild every screen at eighty columns while the terminals themselves carried on
           * at whatever they were, so a reattaching tab was handed a folded-up copy of its own
           * screen and a full-screen program had to be resized before it looked right again.
           *
           * The host has held the true size all along; it was being discarded one call earlier.
           */
          const session = sessions.adopt({
            ...entry,
            cols: entry.cols ?? 80,
            rows: entry.rows ?? 24,
          });
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
        // And the first connection has caught up too: adoption is the same situation as a
        // reconnect, with the whole history as the gap.
        hostClient.reconciled();
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
     * A reconnect is not proof that anything died. Ask before letting go of anything.
     *
     * This used to end **every** session the moment the socket came back, on the reasoning that
     * a reconnect means a new host and a new host means the old one's processes are gone. The
     * second half is true and the first half is not: the socket is reconnected after any close
     * at all, including one the host survives, and an error handler calls `destroy` which closes
     * it. So a single transient socket error would have ended every terminal on the machine
     * while every one of their processes was still running and still adoptable.
     *
     * Nobody has hit it, and that is luck rather than design: it needs one `ECONNRESET`.
     *
     * The host can simply be asked. Sessions it still has are kept, and their missed output is
     * replayed so no screen is left with a hole in it. Sessions it does not have are genuinely
     * gone and are let go, which is the case this was written for and still handles.
     */
    hostClient.onReconnect(() => {
      void (async () => {
        let live: { sessionId: string; seq: number }[] = [];
        try {
          live = await ptyBackend.adoptable();
        } catch (e: unknown) {
          /**
           * The one place where guessing is the safer answer, and the guess is "keep them".
           *
           * If the host cannot be asked, ending everything is unrecoverable and keeping
           * everything costs sessions that answer nothing until the next reconnect, which is
           * seconds away. Nothing is lost by waiting and everything can be by not.
           */
          warn('pty-host.reconnect-unverified', {
            error: String(e),
            kept: decideReconnect(
              sessions.all.map((s) => s.id),
              null,
            ).kept.length,
          });
          hostClient.setBudget(server.scrollbackBytes);
          return;
        }
        /**
         * The same host, or a different one, said by the host rather than guessed from a socket.
         *
         * A reconnection to the same process proves the terminals are exactly where they were,
         * whatever the socket did. Logged either way, because "my session vanished" is answered
         * from this line.
         */
        info('pty-host.reconnect-identity', {
          replaced: hostClient.hostReplaced,
          instance: hostClient.hostInstance ?? 'unknown',
          held: sessions.all.length,
          onHost: live.length,
        });
        const verdict = decideReconnect(
          sessions.all.map((s) => s.id),
          live.map((s) => s.sessionId),
        );
        const stillThere = new Set(verdict.kept);
        if (verdict.lost.length > 0) {
          warn('pty-host.sessions-lost', {
            count: verdict.lost.length,
            kept: verdict.kept.length,
          });
        } else {
          info('pty-host.reconnected-intact', { kept: verdict.kept.length });
        }
        /**
         * Records for sessions the host does not have. Let go, and signal nothing.
         *
         * These were ended by something outside this daemon: the host died, or the process did.
         * Sending a kill for them reaches whichever host is connected **now**, which after a
         * replacement is a process that never had them. Reconciling records must not be able to
         * reach the code that ends somebody's work.
         */
        for (const id of verdict.lost) {
          const session = sessions.get(id);
          if (session) sessions.forgetLostSession(session, 'not-on-host-after-reconnect');
        }
        hostClient.setBudget(server.scrollbackBytes);
        /**
         * And the gap is filled, for the ones that survived.
         *
         * Output produced while the socket was down is held by the host and is asked for from
         * the sequence number this daemon last saw, which is the same mechanism adoption uses.
         * Without it a surviving session comes back with a hole in the middle of its screen,
         * which looks exactly like the corruption this product spent a week removing.
         */
        for (const session of sessions.all) {
          if (!stillThere.has(session.id)) continue;
          try {
            const { missingBytes } = await (ptyBackend as HostPtyBackend).catchUp(session.id);
            /**
             * Output that happened while we were away and is no longer anywhere we can reach.
             *
             * The host keeps a bounded ring, and a session busy enough during a long enough gap
             * overflows it. What arrives then is the recent part, applied on top of a screen that
             * ends somewhere earlier: the result is not a shortened screen, it is a wrong one,
             * and nothing about it looks wrong.
             *
             * Said in the terminal rather than only in a log, because the person reading that
             * screen is the one who needs to know a piece of it is missing. It is printed rather
             * than typed, like every other notice this product puts in a session.
             */
            if (missingBytes > 0) {
              warn('pty-host.replay-gap', { sessionId: session.id, missingBytes });
              const kb = Math.max(1, Math.round(missingBytes / 1024));
              ptyBackend.inject(
                session.id,
                `\r\n\u001b[33m[TabTerm: about ${String(kb)} KB of output was lost while the ` +
                  `terminal service was reconnecting. The session itself is intact.]\u001b[0m\r\n`,
              );
            }
          } catch {
            /* best effort: a screen with a gap beats no session at all */
          }
        }
        /**
         * Caught up. Live output held during this is merged in and delivered now.
         *
         * Until this is said the client holds live frames rather than handing them on, because the
         * host starts broadcasting to a socket the moment it connects and the replay above has not
         * been asked for yet. Delivering both as they arrived put bytes from after the break in
         * front of bytes from during it, and then repeated the overlap.
         */
        hostClient.reconciled();
      })();
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

  /**
   * And, on a first run, ask for the folders macOS guards.
   *
   * After listening rather than before, and never awaited: a folder nobody has decided about
   * blocks until somebody answers, so putting this in front of the server would hold the whole
   * product behind a dialog. See `ask-for-folders.ts` for why they are asked together.
   */
  if (process.platform === 'darwin' && !alreadyAsked()) {
    void askForFolders().catch((e: unknown) => {
      warn('folders.ask-failed', { error: String(e) });
    });
  }
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

  /**
   * Ask the reap policy again, on the daemon's own clock.
   *
   * Every other trigger is an event from somewhere else: a report of open tabs, a reporter going
   * away, a client detaching, the setting changing. So the answer was only ever revisited when
   * Chrome happened to say something, and Chrome stops saying things when its service worker
   * sleeps. Measured on a real machine: three sessions kept a verdict made at daemon startup for
   * thirty-nine minutes, while the setting that was supposed to end them was thirty.
   *
   * This is not a poll for state and it is not a new authorization. It re-runs the same rules
   * with the same evidence, and its whole effect is that the passage of time and the settling of
   * a reporter are noticed without waiting for a browser to speak. A decision already scheduled
   * keeps its deadline, because `#scheduleReap` keeps it while the reason is unchanged.
   *
   * A minute, unref'd. It costs a pure function per idle session.
   */
  const REAP_SWEEP_MS = 60 * 1000;
  const reapSweep = setInterval(() => {
    try {
      sessions.rescheduleIdleReaps();
    } catch (e) {
      warn('reap.sweep.failed', { error: String(e) });
    }
  }, REAP_SWEEP_MS);
  reapSweep.unref();
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
