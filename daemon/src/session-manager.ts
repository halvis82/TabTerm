import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { linesOfContent } from '@tabterm/shared';
import type { AgentState, SessionState, TitleFields } from '@tabterm/shared';
import type { Config } from './config.js';
import { debug, info, warn } from './log.js';
import type { PtyBackend } from './pty-backend.js';
import { OscScanner } from './osc.js';
import { decideReap, describeReap, reapInputFor, type TabDisposition } from './cleanup.js';
import { plainText } from './plain-text.js';
import { expandHome } from './complete-path.js';
import { listeningPorts } from './server-detect.js';
import { assertTransition } from './session-state.js';
import { VtState } from './vt-state.js';

/**
 * How long after a command starts to look for a listening socket.
 *
 * Long enough for a dev server to bind, short enough that the offer arrives while the user is
 * still watching the output that started it.
 */
const SERVER_CHECK_MS = 2500;

export interface AttachedClient {
  clientId: string;
  cols: number;
  rows: number;
  /** The size is a guess made from the window, because nothing was laid out to measure yet. */
  estimated?: boolean;
  /** Called with raw PTY bytes. The transport decides how to frame them. */
  onOutput: (data: Buffer) => void;
}

export interface Session {
  id: string;
  state: SessionState;
  createdAt: number;
  lastAttachedAt: number;
  lastDetachedAt?: number;
  cwd: string;
  shell: string;
  command?: readonly string[];
  pid: number;
  exitCode?: number;
  signal?: number;
  pinned: boolean;
  persistent: boolean;
  /** Set when a listening socket is attributed to this session. Protects it from reaping. */
  listeningPort?: number;
  /** Best-known foreground program, consulted by the reap policy. */
  foregroundProcess?: string;
  /** Latest state reported by an agent CLI's hooks, never inferred from output. */
  agentState?: AgentState;
  /**
   * Somebody has typed into this session, whether or not they pressed Enter.
   *
   * A tab goes back to the start screen only when its one terminal is genuinely untouched, and
   * the screen alone cannot answer that: a half-typed command sits on the prompt line and leaves
   * the line count at one, exactly like a prompt nobody has touched. Nothing in the output says
   * it either, because nothing was run. Only the input does, and only the daemon sees all of it,
   * across a reload and across a tab being recreated.
   */
  hasInput?: boolean;
  /** Somebody asked for this to end, rather than the process ending on its own. */
  endedByRequest?: boolean;
  /**
   * Why TabTerm ended this session, set the moment it decides to.
   *
   * Present means the exit that follows is one TabTerm caused. A shell that is sent a hangup
   * exits non-zero, which is indistinguishable from a command failing if all you have is the
   * code, and it was reported to the user as "Process failed" for a session TabTerm had itself
   * decided to reap. Absent means the process ended on its own, which is the only case where a
   * non-zero code says anything about the user's work.
   */
  endedBy?: TerminationCause['kind'];
  /**
   * Somebody closed the pane this session was in.
   *
   * The authorization for ending a session that is no longer in any workspace. Set when a person
   * closes a pane, and never by anything that merely rearranges or loses a layout.
   */
  paneClosedByUser?: boolean;
  /**
   * This session has emitted command marks, so the integration really is sourced.
   *
   * Proof, as opposed to the profile containing a line that looks right. It can be sourced from
   * anywhere, and a line that is present but never runs looks identical from the file.
   */
  shellIntegration?: boolean;
  titleFields: TitleFields;
  /** Shell integration scanner, fed from the one output path. */
  osc?: OscScanner;
  /**
   * Whether this session's ending has been announced.
   *
   * A session can reach its end twice: reaped by the daemon, and reported by whatever owned the
   * PTY. Both must announce it, since either can happen first, and between them they must
   * announce it exactly once.
   */
  exitAnnounced?: boolean;
  /**
   * How many output bytes this session has produced, as counted by whatever owns the PTY.
   *
   * Kept so a restarted daemon can ask for exactly the bytes it missed rather than the whole
   * buffer. See docs/adr/0017.
   */
  seq: number;
  vt: VtState;
  clients: Map<string, AttachedClient>;
  reapTimer?: NodeJS.Timeout;
  /**
   * When the scheduled reap is due, and what it was scheduled for.
   *
   * The timer used to be cleared and started again from zero on every re-decision, and the
   * policy is re-run for every idle session on every report of open tabs, which a browser sends
   * every two minutes. Any timeout longer than that interval could therefore never elapse: a
   * thirty minute setting produced sessions still sitting in Running Now an hour later, marked
   * background, because the countdown restarted twenty-nine times.
   *
   * Keeping the deadline makes the clock measure elapsed time rather than time since anybody
   * last asked. The reason is kept beside it so a **different** decision still starts a fresh
   * clock, which is what a change of circumstances should do.
   */
  reapDueAt?: number;
  reapReason?: string;
  serverCheckTimer?: NodeJS.Timeout;
  /**
   * A command has been run in this session at least once.
   *
   * A shell that has only ever printed a prompt is a session in the bookkeeping sense and
   * nothing at all to the person who opened the tab. Listing those is what makes "running now"
   * read as a list of things they have never seen before. Set from whichever path notices a
   * command first, integrated or fallback, and never cleared: a session that has done work
   * stays real even when it goes idle again.
   */
  hasRun?: boolean;
  /** Where it was opened, so a session that never went anywhere can be told from one that did. */
  readonly startedIn: string;
  /** Set while a command is running, so the title can show it rather than the shell. */
  commandRunning: boolean;
  commandStartedAt?: number;
  pendingCommand?: string;
  lastExitCode?: number;
}

export interface SessionEvents {
  onExit: (session: Session) => void;
  onStateChange: (session: Session) => void;
  /**
   * Fired when the size the PTY is actually running at changes.
   *
   * The size is the minimum across attached clients, so it is not necessarily the size any one
   * of them asked for. A client that renders at its own size instead is drawing into columns the
   * shell does not know exist, which for a full-screen application is not a cosmetic difference:
   * every wrapped line and every absolute cursor move lands somewhere else.
   */
  onResized?: (session: Session, cols: number, rows: number) => void;
  /** Fired when the shell reports a new directory via OSC 7. */
  onCwd?: (session: Session) => void;
  /** Fired when the composed title fields change. */
  onTitle?: (session: Session) => void;
  /** Fired when a shell command starts, so a pane can show it ticking. */
  onCommandStarted?: (session: Session, command: string, startedAt: number) => void;
  /** Fired when a shell command finishes, with what it was and how it went. */
  onCommand?: (
    session: Session,
    command: string,
    /** Absent when it could not be observed, never guessed. */
    exitCode: number | undefined,
    durationMs: number,
  ) => void;
  /** A session started listening on a local port. Fired once per port, never polled. */
  onServerDetected?: (session: Session, port: number) => void;
  /** Raw output, for the archive. Only called while something is capturing. */
  onOutput?: (session: Session, chunk: string) => void;
  /** A session was created, so anything tracking sessions can start. */
  onCreated?: (session: Session) => void;
  /** Input on its way to the PTY, for the fallback command tracker. */
  onInputWritten?: (session: Session, data: string) => void;
  /** This session has real shell integration, so the fallback should stand down. */
  onIntegrationDetected?: (session: Session) => void;
}

/**
 * How many lines of a screen have anything on them.
 *
 * Used to tell a shell that has only printed its prompt from one somebody has worked in. The
 * screen arrives with the escape sequences that produced it, so those are stripped first: a
 * line that is only a color change is not a line with something on it.
 */
export function usedLines(screen: string): number {
  /**
   * `plainText` already drops empty lines, so what is left is what is on the screen, minus the
   * lines a shell prints that are not output.
   *
   * zsh marks a partial line with a lone inverse `%`, which is furniture rather than work. It
   * was counting, so an adopted session that had only ever shown a prompt looked used, which
   * protects it from the rule that clears untouched panes and puts it in `Running now` as a card
   * holding nothing. See `shell-noise.ts`.
   */
  return linesOfContent(plainText(screen));
}

/** One hour. Exported so restoring settings uses this number rather than its own copy. */
export const DEFAULT_KEEP_BACKGROUND_SECONDS = 60 * 60;

/**
 * How long a browser has to have been reporting before its list is taken as complete.
 *
 * Long enough to cover a worker waking and asking Chrome what it has, and an extension being
 * replaced, both of which produce a short list on the way past. Short enough that a person who
 * closes a tab does not wait noticeably longer than the timeout they chose.
 */
export const SETTLED_AFTER_MS = 30_000;

/**
 * Why TabTerm is allowed to end somebody's process.
 *
 * There is no member of this union that means "something went wrong" or "I could not tell". Every
 * one of them names an act: a person pressed something, or a person closed something and the
 * grace period they were given ran out. If no member fits, the answer is not to end the session.
 */
/**
 * What ending a session actually achieved, as opposed to what was asked for.
 *
 * `gone` means the backend confirmed the process is no longer there. `unconfirmed` means the
 * request was made and nothing came back to say it worked, which is not the same as failure and
 * is certainly not success: the session keeps its record, because a process nothing can see,
 * reach or end is a worse outcome than an entry in a list.
 *
 * Returned rather than logged because callers act on it. Reset in particular used to count what
 * it had asked for and report that as what it had done.
 */
export interface TerminationOutcome {
  sessionId: string;
  outcome: 'gone' | 'unconfirmed';
}

export type TerminationCause =
  /** A person chose Kill session. */
  | { kind: 'user-kill'; keepHistory?: boolean }
  /** A person closed a pane, and it held nothing worth offering an undo for. */
  | { kind: 'user-closed-pane'; keepHistory?: boolean }
  /** A person merged a session into a pane, displacing the shell that was in it. */
  | { kind: 'user-replaced-pane'; keepHistory?: boolean }
  /** A person confirmed Reset TabTerm, which ends everything on purpose. */
  | { kind: 'user-reset'; keepHistory?: boolean }
  /**
   * A tab a person closed, whose background timeout has run out.
   *
   * Carries the evidence itself so the log can say which closing authorized this, and when it
   * was observed, rather than only that a timer fired.
   */
  | {
      kind: 'expired-after-tab-close';
      workspaceId: string;
      closeEventId: string;
      closedAt: number;
      keepHistory?: boolean;
    }
  /** A pane a person closed, whose grace period has run out, in no workspace any more. */
  /**
   * A live browser, with its tabs enumerated, no longer has this workspace.
   *
   * Its own cause rather than being folded into either of the others. The proof is different: no
   * message named this workspace as closed, and no pane of it was closed by hand. What happened
   * is that a settled reporter gave a complete account of its tabs and this was not among them,
   * which is what closing a whole window looks like from here.
   *
   * Named separately so the log says which proof was used, and so nothing can borrow the
   * provenance of an act that did not happen.
   */
  | {
      kind: 'expired-after-window-close';
      workspaceId: string;
      keepHistory?: boolean;
    }
  | { kind: 'expired-after-pane-close'; keepHistory?: boolean };

/** Thrown when a terminal is asked for and there is nothing durable to own it. */
export class NoDurableHostError extends Error {
  constructor() {
    super('the durable PTY host is unavailable, so no terminal was created');
    this.name = 'NoDurableHostError';
  }
}

/**
 * Which browser profile a client belongs to.
 *
 * The extension stores a UUID and connects as `<uuid>:control` for the reporter and
 * `<uuid>:<connection>` for each page, so the first segment is the browser and everything after it
 * is one connection's lifetime. Provenance belongs to the browser: a reconnect is the same Chrome
 * with the same tabs, and treating it as a stranger would mean a window closed while the service
 * worker slept could never be recognised.
 */
function profileOf(clientId: string): string {
  const cut = clientId.indexOf(':');
  return cut === -1 ? clientId : clientId.slice(0, cut);
}

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #config: Config;
  readonly #events: SessionEvents;
  readonly #pty: PtyBackend;

  /**
   * Whether a terminal can be created at all right now.
   *
   * False when there is no durable PTY host. Asked before a session is built rather than
   * discovered afterwards, so a request that cannot be served is refused instead of answered with
   * a session and a workspace wrapped around a process that was never started.
   */
  get canCreate(): boolean {
    return (this.#pty as { unavailable?: boolean }).unavailable !== true;
  }
  /**
   * How long a session is kept after **its tab has been closed**. One hour.
   *
   * It used to be fifteen minutes, and it used to start whenever no client was attached, which
   * is not the same thing at all: a tab that was merely backgrounded or discarded started the
   * clock. Nothing starts until Chrome says the tab is gone, so the number can be generous.
   *
   * Then thirty minutes, and now an hour, because what made a long one expensive is gone. Every
   * session used to cost a pseudo-terminal for the life of the PTY host, so keeping them was
   * spending a machine-wide resource that never came back. That was a leak in node-pty and it
   * is fixed, so keeping a session longer now costs memory and nothing else, and memory is the
   * cheaper thing to spend than somebody's work.
   *
   * `null` keeps them until something else ends them.
   */
  keepBackgroundSeconds: number | null = DEFAULT_KEEP_BACKGROUND_SECONDS;

  /**
   * Re-apply the reap policy to every detached session.
   *
   * Called when the timeout changes, because somebody who just shortened it means the sessions
   * they can see, not only the ones that detach afterwards.
   */
  rescheduleReaps(): void {
    for (const session of this.#sessions.values()) {
      if (session.clients.size === 0 && session.state !== 'exited') {
        clearTimeout(session.reapTimer);
        delete session.reapTimer;
        // Every deadline was measured against the previous setting, so somebody who has just
        // changed it means the new one, counted from now.
        delete session.reapDueAt;
        delete session.reapReason;
        this.#scheduleReap(session);
      }
    }
  }

  constructor(config: Config, events: SessionEvents, pty: PtyBackend) {
    this.#config = config;
    this.#events = events;
    this.#pty = pty;

    // One pair of listeners for every session, because the backend is a single connection
    // rather than a handle per process.
    this.#pty.onData((sessionId, data) => this.#ingest(sessionId, data));
    this.#pty.onExit((sessionId, exitCode, signal) => this.#ended(sessionId, exitCode, signal));
    this.#pty.onSpawned((sessionId, pid) => {
      const session = this.#sessions.get(sessionId);
      if (session) session.pid = pid;
    });
  }

  /** Output arriving from wherever the PTY lives. Always accepted, never paused: invariant 3. */
  #ingest(sessionId: string, data: Buffer): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.seq += data.length;
    session.vt.write(data);
    const text = data.toString('utf8');
    session.osc?.feed(text);
    this.#events.onOutput?.(session, text);
    for (const client of session.clients.values()) client.onOutput(data);
  }

  #ended(sessionId: string, exitCode: number, signal?: number): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.exitCode = exitCode;
    if (signal !== undefined) session.signal = signal;

    // A pane that ran a declared command keeps its output, so the notice goes into the
    // terminal state itself rather than being drawn by whoever happens to be attached.
    // Reattaching later shows the same thing. See docs/04-session-lifecycle.md §9.
    if (session.command?.length) {
      const notice = `\r\n\x1b[2m[${describeExit(exitCode, signal)}]\x1b[0m\r\n`;
      const buf = Buffer.from(notice, 'utf8');
      session.vt.write(buf);
      for (const client of session.clients.values()) client.onOutput(buf);
    }

    this.#transition(session, 'exited');
    info('session.exited', { sessionId, exitCode, signal });
    this.#announceExit(session);
  }

  get all(): Session[] {
    return [...this.#sessions.values()];
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /**
   * A terminal size a terminal could actually have.
   *
   * The numbers come off the wire from a page, and a page can say anything. Asking for a session
   * of `Number.MAX_SAFE_INTEGER` rows makes the VT try to allocate one line object per row: the
   * daemon dies of an out-of-memory abort, and every terminal on the machine dies with it,
   * because this process holds them all. Found by throwing malformed messages at the daemon,
   * which is the first thing that had ever tried.
   *
   * Clamped rather than rejected. A wrong size is a cosmetic problem that the next real resize
   * corrects, and refusing to open somebody's terminal because a measurement arrived garbled
   * would be a worse answer than opening it slightly wrong. The bounds are far outside any real
   * display and far inside what can be allocated.
   */
  static sane(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(1000, Math.max(1, Math.floor(value)));
  }

  create(opts: { cwd?: string; command?: readonly string[]; cols: number; rows: number }): Session {
    /**
     * Refused when there is no durable PTY host, before anything is built.
     *
     * Nine call sites reach this method, and guarding each one is nine chances to miss the next.
     * The refusal belongs where the decision is: a session that cannot own a process is not a
     * session, and returning one leaves a pane showing nothing and a row in Running Now for a pid
     * that does not exist.
     */
    if (!this.canCreate) throw new NoDurableHostError();
    const id = randomUUID();
    /**
     * A tilde is expanded here, once, for every way a session can be created.
     *
     * A page may legitimately hold a path as `~/Documents`: that is what somebody typed and it
     * is what should be shown back to them. It is not a directory any process can start in, and
     * handing it to `spawn` fails with `posix_spawnp failed`, which names nothing and reads as
     * the product being broken. The daemon owns the filesystem, so the daemon does the
     * expanding, rather than every caller remembering to.
     */
    const cwd = expandHome(opts.cwd ?? homedir());
    const cols = SessionManager.sane(opts.cols, 80);
    const rows = SessionManager.sane(opts.rows, 24);
    const vt = new VtState(cols, rows, this.#config.scrollbackLines);

    const session: Session = {
      id,
      state: 'starting',
      createdAt: Date.now(),
      lastAttachedAt: Date.now(),
      cwd,
      startedIn: cwd,
      shell: this.#config.shell,
      // Filled in when whatever owns the PTY reports it, which is a round trip away when that
      // is another process. Nothing here needs it sooner.
      pid: 0,
      pinned: false,
      persistent: false,
      titleFields: { cwd },
      seq: 0,
      vt,
      clients: new Map(),
      commandRunning: false,
    };
    if (opts.command) session.command = opts.command;

    const osc = this.#buildOsc(session);
    session.osc = osc;
    // Registered before the PTY is asked for, not after. The pid and the first bytes are both
    // addressed by session id, and an in-process backend delivers them during the spawn call
    // itself, so a session that is not in the map yet loses them silently.
    this.#sessions.set(id, session);
    this.#pty.spawn({
      shell: this.#config.shell,
      cwd,
      // The clamped pair, so the PTY and this daemon's own screen agree about the geometry.
      cols,
      rows,
      sessionId: id,
      ...(opts.command ? { command: opts.command } : {}),
    });
    this.#events.onCreated?.(session);
    info('session.created', { sessionId: id });
    return session;
  }

  /**
   * Take over a session that was already running when this daemon started.
   *
   * Built exactly like a created one except that nothing is spawned, because the process is
   * already there. The screen is rebuilt by the caller replaying what the host buffered, which
   * arrives through the ordinary output path and lands in this VT.
   */
  /**
   * Shell integration reports meaning the daemon cannot infer from bytes alone.
   *
   * Shared by created and adopted sessions, because a session taken over after a restart needs
   * exactly the same scanner as one that was just started. Two copies of this would drift, and
   * the drift would look like shell integration working in some tabs and not others.
   */
  #buildOsc(session: Session): OscScanner {
    return new OscScanner({
      onCwd: (cwd) => {
        if (cwd === session.cwd) return;
        session.cwd = cwd;
        session.titleFields = { ...session.titleFields, cwd };
        this.#events.onCwd?.(session);
        this.#events.onTitle?.(session);
      },
      onCommandStart: () => {
        session.commandRunning = true;
        session.commandStartedAt = Date.now();
        // Proof this session has real shell integration. The fallback tracker stands down for
        // good, so the two can never both report the same command.
        session.shellIntegration = true;
        this.#events.onIntegrationDetected?.(session);
      },
      onCommandText: (command) => {
        session.pendingCommand = command;
        // The text arrives just after the start mark, so the start event waits for it: a
        // pane showing "running" without saying what is more alarming than useful.
        const startedAt = session.commandStartedAt ?? Date.now();
        this.#events.onCommandStarted?.(session, command, startedAt);
        // Through the shared hook rather than straight to the server check, so that both this
        // path and the fallback tracker mark the session the same way.
        this.noteCommandStarted(session, command);
      },
      onCommandEnd: (exitCode) => {
        const startedAt = session.commandStartedAt;
        session.commandRunning = false;
        session.lastExitCode = exitCode;
        delete session.commandStartedAt;
        this.#events.onTitle?.(session);
        // The command text comes from the shell integration. Without it sourced there is
        // simply nothing to record, and history stays empty rather than guessing.
        const text = session.pendingCommand;
        delete session.pendingCommand;
        if (text) {
          this.#events.onCommand?.(session, text, exitCode, startedAt ? Date.now() - startedAt : 0);
        }
      },
      onPromptStart: () => {
        session.commandRunning = false;
      },
    });
  }

  adopt(info_: {
    sessionId: string;
    pid: number;
    cwd: string;
    shell: string;
    command?: readonly string[];
    cols: number;
    rows: number;
    /** When the host started it, which is older than this daemon and usually older than the last. */
    startedAt?: number;
    /** Somebody typed into it, remembered by the host across this daemon's restart. */
    hasInput?: boolean;
    /** A person closed its pane, remembered by the host across this daemon's restart. */
    paneClosedByUser?: boolean;
  }): Session {
    const vt = new VtState(info_.cols, info_.rows, this.#config.scrollbackLines);
    /**
     * The host's own idea of when this began, not the moment we noticed it.
     *
     * Treating an adopted session as brand new resets the clock that eventually lets go of one
     * nobody has claimed in weeks, and a daemon restart happens on every update, so on a machine
     * that keeps itself current that clock would never have run out.
     *
     * Safe to date it this way because a tab that is genuinely watching reconnects within
     * seconds of the daemon coming back, and attaching sets the clock forward honestly.
     */
    const began = info_.startedAt ?? Date.now();
    const session: Session = {
      id: info_.sessionId,
      // Live with nobody attached, which is exactly what an adopted session is until a tab
      // reconnects to it.
      state: 'detached',
      createdAt: began,
      lastAttachedAt: began,
      cwd: info_.cwd,
      // Adopted, so nobody knows where it began. Its current directory is the honest answer,
      // and it is marked as having run something anyway, so nothing depends on this.
      startedIn: info_.cwd,
      shell: info_.shell,
      pid: info_.pid,
      pinned: false,
      persistent: false,
      // Carried over from the host, which kept it across this daemon's restart. Without it a
      // terminal somebody had typed into looked untouched again after every update.
      ...(info_.hasInput === true ? { hasInput: true } : {}),
      // The authorization to end it, which the daemon cannot remember on its own.
      ...(info_.paneClosedByUser === true ? { paneClosedByUser: true } : {}),
      titleFields: { cwd: info_.cwd },
      seq: 0,
      vt,
      clients: new Map(),
      commandRunning: false,
      /**
       * Whether it was ever used is read off its screen, not assumed.
       *
       * It used to be assumed true, on the reasoning that a session which outlived a daemon had
       * plainly been used. That is not true of a shell somebody opened and left: it outlives a
       * daemon restart exactly as readily as a busy one. The result was empty shells appearing
       * in `Running now` as cards holding nothing but a prompt, and being protected from the
       * rule that clears untouched panes away.
       *
       * The screen is the evidence available. More than one line with anything on it means
       * something was run, because a shell that has only printed its prompt has exactly one.
       */
      hasRun: usedLines(vt.snapshot(0).screen) > 1,
    };
    if (info_.command) session.command = info_.command;
    session.osc = this.#buildOsc(session);
    this.#sessions.set(session.id, session);
    /**
     * An adopted session has no client, and never had one in this daemon's lifetime.
     *
     * The reap timer is normally scheduled when the last client detaches, an event that will
     * never fire for one of these, so without this they live forever. Before the PTY host that
     * was impossible, because a daemon restart killed everything. Now it leaks: measured at 28
     * abandoned shells after a day of development.
     */
    this.#scheduleReap(session);
    info('session.adopted', { sessionId: session.id, pid: info_.pid });
    return session;
  }

  attach(session: Session, client: AttachedClient): void {
    if (session.state === 'exited' || session.state === 'reaped') {
      throw new Error('session-expired');
    }
    /**
     * The size this client claims, clamped before it is believed.
     *
     * `#applyResize` takes the smallest size across everything attached and hands it to the VT,
     * so one client claiming `Number.MAX_SAFE_INTEGER` rows is enough to make the VT try to
     * allocate a line object per row. The daemon dies of an out-of-memory abort and every
     * terminal on the machine dies with it, because this process holds them all.
     *
     * Clamping at `create` was not enough: this is the other door into the same number, and it
     * is the one a reattach comes through.
     */
    client.cols = SessionManager.sane(client.cols, 80);
    client.rows = SessionManager.sane(client.rows, 24);
    /**
     * A client that is already attached keeps the size it has, rather than being handed one.
     *
     * Several attach paths pass a placeholder, because the caller has no idea how big the panes
     * are and the client corrects it a moment later. That was harmless while nobody was told
     * about the applied size. It is not harmless now: the placeholder becomes the size of the
     * terminal, every view is told, and the view sets its grid to 80 by 24 and then measures its
     * way back. Ninety-five size changes in two seconds, which is a terminal that visibly
     * flickers.
     *
     * The size a client last reported is a fact about that client. An attach is not new
     * information about it.
     */
    const known = session.clients.get(client.clientId);
    if (known) {
      client.cols = known.cols;
      client.rows = known.rows;
    } else if (client.estimated && session.vt.cols > 0 && session.vt.rows > 0) {
      /**
       * And a client that says its size is a guess does not move a terminal that already has one.
       *
       * A page that has just loaded has no pane with a box to measure, so it works a size out
       * from the window. That guess is systematically too big, and it was being applied: every
       * tab open resized the terminal to the guess and then to the real measurement a tenth of a
       * second later. Harmless for a shell, and not harmless for a full-screen program, which
       * redraws itself completely on each one. That is an agent visibly reflowing at the wrong
       * width every single time its tab is opened.
       *
       * The rule that already covers a returning client covers this too, and for the same
       * reason: an attach is not new information about how big anything is. The measurement
       * follows in a moment and is believed then.
       *
       * Only when the session already has a size. A session being created has nothing better to
       * go on, and nothing on screen to reflow.
       */
      client.cols = session.vt.cols;
      client.rows = session.vt.rows;
    }
    session.clients.set(client.clientId, client);
    session.lastAttachedAt = Date.now();
    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      delete session.reapTimer;
      debug('session.reap.cancelled', { sessionId: session.id });
    }
    // The tab is back, so the deadline it was counting to is void rather than paused. A session
    // reattached for an hour and detached again gets the whole timeout, not what was left of it.
    delete session.reapDueAt;
    delete session.reapReason;
    this.#transition(session, 'attached');
    this.#applyResize(session, 'attach');
  }

  detach(session: Session, clientId: string): void {
    if (!session.clients.delete(clientId)) return;
    if (session.clients.size > 0) {
      this.#applyResize(session, 'detach');
      return;
    }
    session.lastDetachedAt = Date.now();
    if (session.state === 'exited' || session.state === 'reaped') return;
    this.#transition(session, 'detached');

    // Check for a listening socket before deciding. This is the only moment the answer
    // matters, so it is asked here rather than polled.
    void listeningPorts([session.pid])
      .then((ports) => {
        const port = ports.get(session.pid);
        if (port !== undefined) session.listeningPort = port;
      })
      .catch(() => {
        /* detection is best effort; without it the session just follows the normal policy */
      })
      .finally(() => {
        if (session.state === 'detached') this.#scheduleReap(session);
      });
  }

  resize(session: Session, clientId: string, cols: number, rows: number): void {
    const client = session.clients.get(clientId);
    if (!client) return;
    client.cols = SessionManager.sane(cols, client.cols);
    client.rows = SessionManager.sane(rows, client.rows);
    this.#applyResize(session, 'resize-pane');
  }

  /**
   * Put something on a session's screen that no process produced.
   *
   * Fed to this daemon's own terminal state as well as to the backend, so the screen the daemon
   * would hand a reattaching tab matches what everyone is looking at right now.
   */
  inject(session: Session, text: string): void {
    if (session.state === 'exited' || session.state === 'reaped') return;
    this.#pty.inject(session.id, text);
  }

  write(session: Session, data: Buffer): void {
    if (session.state === 'exited' || session.state === 'reaped') return;
    const text = data.toString('utf8');
    // Typed into, and so no longer an untouched terminal. Set on the first keystroke and never
    // cleared: a session somebody has used stays used.
    if (text.length > 0) session.hasInput = true;
    // The fallback command tracker needs to know when Enter was pressed. It ignores everything
    // else, so this costs a substring check per keystroke.
    this.#events.onInputWritten?.(session, text);
    this.#pty.write(session.id, text);
  }

  /**
   * Apply a new scrollback cap to every live session.
   *
   * A memory mode that only affected sessions started after the change would not reduce memory
   * on the machine it was chosen for.
   */
  applyScrollback(lines: number): void {
    for (const session of this.all) session.vt.setScrollback(lines);
    info('sessions.scrollback.applied', { lines, sessions: this.all.length });
  }

  setPersistent(session: Session, persistent: boolean): void {
    session.persistent = persistent;
    if (persistent && session.reapTimer) {
      clearTimeout(session.reapTimer);
      delete session.reapTimer;
      delete session.reapDueAt;
      delete session.reapReason;
    }
  }

  setPinned(session: Session, pinned: boolean): void {
    session.pinned = pinned;
    if (pinned && session.reapTimer) {
      clearTimeout(session.reapTimer);
      delete session.reapTimer;
      delete session.reapDueAt;
      delete session.reapReason;
    }
  }

  /**
   * End a session.
   *
   * `keepHistory` when this was a timeout rather than a person: nobody asked for it, a tab may
   * still be open on it, and its output is what that tab has left to show.
   */
  /**
   * `byRequest` means a person asked for this to be gone, rather than a process ending.
   *
   * It decides what happens to the pane. A pane that ran a declared command keeps its pane when
   * the command finishes, because its output is the reason it existed. That is exactly wrong for
   * a kill: somebody chose `Kill session` on that pane, and leaving the pane sitting there
   * holding a dead terminal is the opposite of what they asked for.
   */
  /**
   * End a live terminal, naming what authorizes it.
   *
   * Every path that can send a signal to somebody's process goes through here, and the cause is
   * required rather than optional so that no caller can reach it without saying why it is allowed
   * to. That is the point of the type: `terminate(session)` does not compile, and a reader
   * searching for the ways this product can end a process finds them by their cause rather than
   * by guessing which `kill` is which.
   *
   * Reconciling records is **not** this. A session the backend no longer has is
   * `forgetLostSession`, which signals nothing. A transport that dropped, a host that was
   * replaced, a daemon shutting down: none of them come here.
   */
  async terminate(session: Session, cause: TerminationCause): Promise<TerminationOutcome> {
    if (cause.kind === 'user-kill') session.endedByRequest = true;
    // Before the signal, because the exit it causes can arrive before this call returns.
    session.endedBy = cause.kind;
    /**
     * Written down before anything is signalled, and with the authorization in it.
     *
     * A session that disappears without one of these lines is a defect, and this is what makes
     * that statement checkable.
     */
    info('session.terminating', {
      sessionId: session.id,
      cause: cause.kind,
      ...('workspaceId' in cause ? { workspaceId: cause.workspaceId } : {}),
      ...('closeEventId' in cause ? { closeEventId: cause.closeEventId } : {}),
      ...('closedAt' in cause ? { closedAt: new Date(cause.closedAt).toISOString() } : {}),
    });
    /**
     * The record is let go of only once the backend says the process is gone.
     *
     * A kill that was not acknowledged is a kill that may not have happened: the host could have
     * been disconnected, or replaced. Forgetting the session then leaves a process running that
     * nothing can see, reach, or end, which is a worse outcome than an entry in Running Now for
     * something already dead.
     */
    try {
      await this.#pty.kill(session.id, cause.keepHistory === true);
    } catch (e: unknown) {
      warn('session.terminate.unconfirmed', {
        sessionId: session.id,
        cause: cause.kind,
        error: String(e),
      });
      return { sessionId: session.id, outcome: 'unconfirmed' };
    }
    this.#reap(session);
    return { sessionId: session.id, outcome: 'gone' };
  }

  /**
   * A person closed the pane this session was in.
   *
   * Written down twice on purpose. Here, because every rule that runs while this daemon lives
   * reads it from the session; and in the backend, because this daemon will be replaced on the
   * next update and the authorization has to outlive it. Without the second, a session whose
   * pane was closed came back after a restart with nothing saying why it was allowed to go, so
   * it was kept forever, in no workspace and unreachable from any tab.
   */
  notePaneClosedByUser(session: Session): void {
    session.paneClosedByUser = true;
    this.#pty.markPaneClosed?.(session.id);
  }

  /**
   * The backend no longer has this session. Let go of it, and signal nothing.
   *
   * Not `kill`. Killing is a destructive operation aimed at a live process, and this is the
   * opposite situation: the process is already beyond reach, and the only thing left to do is
   * stop claiming to own it. Using `kill` here sends a termination request for a session that
   * does not exist, to whichever host happens to be connected now, which after a host has been
   * replaced is a process that never had it.
   *
   * The distinction is the whole point. A daemon reconciling its records must not be able to
   * reach the code path that ends somebody's work.
   */
  forgetLostSession(session: Session, why: string): void {
    info('session.backend-lost', { sessionId: session.id, why });
    this.#reap(session);
  }

  /**
   * The PTY has one size. With N attached clients the applied size is the minimum cols and
   * minimum rows across all of them, computed per dimension. Any larger client would render
   * into columns the shell does not know exist. See docs/04-session-lifecycle.md §2.
   */
  #applyResize(session: Session, why = 'unknown'): void {
    if (session.clients.size === 0) return; // Retain the last size when nobody is attached.
    let cols = Infinity;
    let rows = Infinity;
    for (const c of session.clients.values()) {
      cols = Math.min(cols, c.cols);
      rows = Math.min(rows, c.rows);
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols === session.vt.cols && rows === session.vt.rows) return;
    /**
     * Who claimed what, and at info, because this is the record that says whether terminals are
     * holding still.
     *
     * It was at debug, which meant it was written by nobody's daemon: answering "is it stable"
     * needed a special build, and in the meantime the absence of these lines was read as the
     * absence of the fault. That is not a mistake worth being able to make twice.
     *
     * It is affordable because a size that did not change returned above this line. Every line
     * here is a real change, and a machine holding still writes none of them for hours. A machine
     * that is not holding still writes a great many, which is the point.
     */
    info('session.resize.applied', {
      why,
      sessionId: session.id.slice(0, 8),
      applied: `${String(cols)}x${String(rows)}`,
      claims: [...session.clients.values()]
        .map((c) => `${c.clientId.slice(-6)}:${String(c.cols)}x${String(c.rows)}`)
        .join(' '),
    });
    session.vt.resize(cols, rows);
    try {
      this.#pty.resize(session.id, cols, rows);
    } catch (e) {
      warn('session.resize.failed', { sessionId: session.id, error: String(e) });
    }
    // Everybody attached is told, because this is the size their grid has to be, not the size
    // they asked for.
    this.#events.onResized?.(session, cols, rows);
  }

  /**
   * Schedule a reap, or decline to.
   *
   * The decision and its reason are always logged. A session disappearing without an
   * explanation is indistinguishable from a bug. See docs/04-session-lifecycle.md §4.
   */
  /**
   * Look for a newly listening port shortly after a command starts.
   *
   * Event driven, not polled: a dev server binds within a second or two of being started, and
   * checking on that one event costs a single `lsof` rather than a timer that runs forever.
   * Reported once per port, so restarting a server on the same port does not re-announce it.
   */
  /**
   * A command started, reported by something other than OSC 133.
   *
   * Exists so the fallback tracker gets the same server check the integrated path gets, without
   * reaching into private state to do it.
   */
  noteCommandStarted(session: Session, command?: string): void {
    /**
     * Only a real command counts as having used a session.
     *
     * Pressing Return at an empty prompt produces a command mark with nothing in it, and that
     * was enough to mark the session as used. The result was untouched shells being offered for
     * reopening and appearing in `Running now` as cards showing three bare prompts, which is
     * exactly the debris this flag exists to keep out.
     *
     * Absent means "something ran and we could not read what", which the fallback tracker can
     * legitimately report, so that still counts.
     */
    if (command !== undefined && command.trim() === '') return;
    session.hasRun = true;
    this.#checkForServer(session);
  }

  #checkForServer(session: Session): void {
    if (session.serverCheckTimer) clearTimeout(session.serverCheckTimer);
    const timer = setTimeout(() => {
      delete session.serverCheckTimer;
      void listeningPorts([session.pid])
        .then((ports) => {
          const port = ports.get(session.pid);
          if (port === undefined || port === session.listeningPort) return;
          session.listeningPort = port;
          this.#events.onServerDetected?.(session, port);
        })
        .catch(() => {
          /* best effort. A missing answer means no offer, which is the safe direction. */
        });
    }, SERVER_CHECK_MS);
    timer.unref();
    session.serverCheckTimer = timer;
  }

  /**
   * Which workspaces have a tab, **per reporting browser**, unioned.
   *
   * One set replaced by whoever reported last was wrong, and wrong in the direction that ends
   * terminals. Anything that can report is a browser with its own tabs: a second Chrome profile,
   * a second browser with the extension, or the several headless ones the browser suites use.
   * Each of them only knows its own tabs, so the last report to arrive erased everybody else's
   * and their sessions were put on a clock while their tabs sat open.
   *
   * A session is protected if **any** reporter still shows it. Empty means nobody has reported
   * at all, which is read as "nobody could tell us" rather than as "there are none".
   */
  readonly #openWorkspaces = new Map<string, ReadonlySet<string>>();

  /**
   * When each reporter first said anything, so a claim can be required to have settled.
   *
   * A browser that has just connected has not finished finding out what it has. Its first report
   * can be empty, or short, simply because the worker woke before it could ask Chrome, and an
   * extension that is being replaced produces exactly the same thing on the way past. Neither is
   * a browser saying a workspace is closed; both are a browser that has not finished speaking.
   *
   * A reporter counts once it has been connected and reporting for `SETTLED_AFTER_MS`. Until
   * then its list protects what is in it and proves nothing about what is not.
   */
  readonly #reporterSince = new Map<string, number>();

  /**
   * Which workspaces each browser has actually told us it had.
   *
   * Provenance, and the thing the settling rule on its own does not have. "No current list contains
   * W, and some reporter is settled" is not evidence that W closed: it is one browser saying it
   * does not have W, and a browser that never had W cannot speak about it at all. Two Chrome
   * profiles produce exactly that, and the mistake runs in the fatal direction, because a settled
   * stranger was enough to start the clock on somebody else's terminal.
   *
   * Keyed by profile rather than by connection. The extension stores a UUID in
   * `chrome.storage.local` and connects as `<uuid>:control`, so the profile survives the reconnect
   * that happens every time the service worker sleeps; only the settling clock restarts. Keeping
   * provenance across that is what lets a window closed while the worker was asleep still be
   * recognised once the browser is awake and settled again.
   *
   * Kept when a reporter goes away, because it says what that browser has held rather than what it
   * holds now, and a browser that is gone contributes nothing regardless: the check below requires
   * a reporter that is currently connected and settled.
   */
  readonly #reporterSeen = new Map<string, Set<string>>();

  /**
   * How long a reporter must have been reporting before its list counts as complete.
   *
   * A field rather than a constant so a test can make a browser settle immediately. The waiting
   * is the safety property; the length of it is a judgement about how long a browser takes to
   * find out what it has.
   */
  settledAfterMs: number = SETTLED_AFTER_MS;

  /**
   * A browser opened this workspace, which is provenance as strong as reporting it.
   *
   * A workspace exists because a tab in some browser asked for it, and that browser plainly had it
   * at that moment. Without this, the ordinary single-browser case has no provenance until the
   * next poll happens to mention it, and a tab closed before that poll would leave the workspace
   * unattributable and its session immortal.
   */
  noteWorkspaceOwner(clientId: string, workspaceId: string): void {
    const profile = profileOf(clientId);
    let seen = this.#reporterSeen.get(profile);
    if (seen === undefined) {
      seen = new Set<string>();
      this.#reporterSeen.set(profile, seen);
    }
    seen.add(workspaceId);
  }

  /** Which browsers are known to have held this workspace. For tests and for diagnostics. */
  ownersOf(workspaceId: string): string[] {
    const out: string[] = [];
    for (const [profile, seen] of this.#reporterSeen) if (seen.has(workspaceId)) out.push(profile);
    return out;
  }

  /** Told by each extension, on every tab event and on a poll. */
  reportOpenWorkspaces(clientId: string, ids: readonly string[]): void {
    if (!this.#reporterSince.has(clientId)) this.#reporterSince.set(clientId, Date.now());
    this.#openWorkspaces.set(clientId, new Set(ids));
    // Everything this browser has ever positively claimed, which is the only basis on which it may
    // later be believed about the same workspace being gone.
    const profile = profileOf(clientId);
    let seen = this.#reporterSeen.get(profile);
    if (seen === undefined) {
      seen = new Set<string>();
      this.#reporterSeen.set(profile, seen);
    }
    for (const id of ids) seen.add(id);
    // A session whose tab has come back must lose the clock it was put on, and one whose tab has
    // gone must be given one. Both are just the policy run again.
    for (const session of this.all) this.#rescheduleReapIfIdle(session);
  }

  /**
   * A browser that has gone stops speaking for its tabs.
   *
   * Its last report is not evidence about the world any more; keeping it would protect sessions
   * belonging to a Chrome that is no longer running. Dropping it is safe because an empty map
   * means "unknown", which still keeps everything.
   */
  forgetReporter(clientId: string): void {
    this.#reporterSince.delete(clientId);
    if (!this.#openWorkspaces.delete(clientId)) return;
    for (const session of this.all) this.#rescheduleReapIfIdle(session);
  }

  /**
   * The timer fired and nothing authorizes ending this. Put it back and say so.
   *
   * `expiring` is the only state this can be reached from that has anywhere to go: a session
   * whose process ended while the timer was pending is already `exited`, and `exited` may only
   * become `reaped`. Asking for `detached` there threw out of a timer callback, which is not a
   * place an exception can be caught.
   */
  #cancelUnauthorized(session: Session, workspaceId: string): void {
    info('session.reap.unauthorized', { sessionId: session.id, workspaceId });
    delete session.reapTimer;
    delete session.reapDueAt;
    delete session.reapReason;
    if (session.state === 'expiring') this.#transition(session, 'detached');
  }

  /**
   * Ask the policy again for every idle session, without any new evidence.
   *
   * For the daemon's own sweep. Everything else that re-runs the policy is an event from
   * elsewhere, so the answer went stale whenever Chrome stopped speaking: a settling reporter
   * that had since settled, and elapsed time, were both invisible until something arrived.
   *
   * Changes no rule and grants nothing. A session already on a clock keeps its deadline, because
   * the reason is unchanged and `#scheduleReap` keeps the deadline while that is true.
   */
  rescheduleIdleReaps(): void {
    for (const session of this.all) this.#rescheduleReapIfIdle(session);
  }

  /** Only for a session nobody is attached to: an attached one has no timer to change. */
  #rescheduleReapIfIdle(session: Session): void {
    if (session.clients.size > 0) return;
    this.#scheduleReap(session);
  }

  /**
   * Whether Chrome still shows this session, as far as anybody has said.
   *
   * `null` only when nobody has reported at all, or when nothing has been wired up to map a
   * session to a workspace, which would be a bug rather than a state and is read as "unknown"
   * so that it keeps the terminal instead of ending it.
   *
   * A session that belongs to no workspace answers `false` once a report exists. A tab always
   * carries a workspace in its URL, so a session outside one cannot be in a tab and is left to
   * the ordinary rules for an unattached shell.
   */
  /**
   * What is known about the tab this session's workspace lives in.
   *
   * Two sources, and they are not symmetric. A report that names a workspace **proves** a tab is
   * open, and that is protective. Nothing proves a tab was closed except an explicit statement
   * that somebody closed it, which the extension sends and which lands in `#closedWorkspaces`.
   *
   * Absence from a report proves nothing at all. It used to return `false` here and `false` was
   * read as authorization to start ending the session, so closing Chrome, closing a window,
   * reloading the extension, a teardown race, or a second profile that never had the workspace
   * were all indistinguishable from somebody deliberately closing a terminal.
   */
  #tabDisposition(sessionId: string): TabDisposition {
    if (this.#workspaceOf === undefined) return 'unknown';
    const workspaceId = this.#workspaceOf(sessionId);
    if (workspaceId === undefined) return 'unknown';
    /**
     * Open beats closed, always.
     *
     * A tab that says it is open now settles it, whatever was recorded earlier: reopening a
     * workspace inside the window is exactly the case the timer exists to be cancelled by.
     */
    for (const reported of this.#openWorkspaces.values()) {
      if (reported.has(workspaceId)) return 'open';
    }
    if (this.#closedWorkspaces.has(workspaceId)) return 'closed';

    /**
     * A settled browser saying what it has is information. Silence is not.
     *
     * This is the distinction that decides whether the timeout somebody chose ever applies. Every
     * unsafe reading of "the workspace is not in this list" comes from a list that was never a
     * complete account of anything: nobody connected at all, or a browser that has just started,
     * or an extension being replaced, all of which produce a short list or none.
     *
     * A reporter that has been connected and reporting for a while is different. It is a live
     * browser, with its tabs enumerated, saying it does not have this workspace open. Requiring
     * an explicit close event on top of that is requiring a message that cannot exist for any
     * tab closed before the message did, which is why sessions from days ago sat in Running Now
     * marked "background" and outlived the setting that was supposed to end them.
     *
     * Every reporter must be settled. One browser still waking up is enough to withhold the
     * conclusion, which is the safe direction and costs only a delay.
     */
    /**
     * A settled reporter is one whose list can be believed. An unsettled one is ignored, not
     * obeyed, and not allowed to speak for the others.
     *
     * This used to withhold the answer whenever **any** reporter was still settling, which reads
     * as caution and behaves as never. Chrome's control client reconnects every time its service
     * worker sleeps and wakes, nine times in forty minutes on a real machine, and each reconnect
     * is a new client id with a fresh timestamp. There was almost always one settling, so nothing
     * anywhere could ever be judged closed and the timeout never applied to anything.
     *
     * Ignoring an unsettled reporter is safe in the direction that matters. Its list cannot say a
     * workspace is gone, because it is not consulted. It can still say a workspace is **open**:
     * the loop above runs over every reporter, settled or not, and a single mention protects the
     * session absolutely. And the decision is taken again when the timer fires, by which time a
     * browser that was waking has long since reported.
     */
    /**
     * And it must be a browser that had this workspace, not merely a browser that is settled.
     *
     * The reporter has to be connected now, settled now, and have positively reported this
     * workspace at some point as the same profile. That is the whole of "it was here and now it is
     * not", said by the only party that can say it.
     *
     * A browser that owned it and disappeared without ever reporting its absence contributes
     * nothing: it is not in `#reporterSince` any more, so it cannot be the reporter found here.
     * That is deliberately unknown rather than agreement.
     */
    const now = Date.now();
    for (const [clientId, since] of this.#reporterSince) {
      if (now - since < this.settledAfterMs) continue;
      if (this.#reporterSeen.get(profileOf(clientId))?.has(workspaceId) === true) return 'closed';
    }
    return 'unknown';
  }

  /**
   * Workspaces somebody deliberately closed the tab of, and when.
   *
   * The only thing in this class that can authorize an automatic ending. Written from an explicit
   * message and from nothing else: never from a socket closing, never from a report that failed
   * to mention something, never from a reporter going away.
   */
  readonly #closedWorkspaces = new Map<string, { at: number; eventId: string }>();

  /**
   * Somebody closed the tab holding this workspace, and the extension is sure of it.
   *
   * Sure means all of these, checked in the extension because it is the only party that can see
   * them: an individual tab removal rather than a window or a browser closing; a workspace known
   * from a mapping written while the tab was alive; no other tab still showing that workspace;
   * and, after a short wait, the same extension incarnation still running and the workspace still
   * unshown. The wait is what a teardown cannot survive.
   *
   * The daemon takes this at face value and does not second-guess it. It cannot: nothing on this
   * side can distinguish a person closing a tab from a browser taking its windows down.
   */
  recordTabClosed(workspaceId: string, eventId: string): void {
    this.#closedWorkspaces.set(workspaceId, { at: Date.now(), eventId });
    info('workspace.tab-closed', { workspaceId, eventId });
    this.rescheduleReaps();
  }

  /** A workspace open again, so whatever was recorded about closing it is no longer true. */
  forgetTabClosed(workspaceId: string): void {
    if (this.#closedWorkspaces.delete(workspaceId)) {
      info('workspace.tab-reopened', { workspaceId });
      this.rescheduleReaps();
    }
  }

  /** What authorized an automatic ending, for the log that records it. */
  closeEvidence(workspaceId: string): { at: number; eventId: string } | undefined {
    return this.#closedWorkspaces.get(workspaceId);
  }

  /** Set by the server, which owns the workspace store. */
  #workspaceOf: ((sessionId: string) => string | undefined) | undefined;

  setWorkspaceLookup(fn: (sessionId: string) => string | undefined): void {
    this.#workspaceOf = fn;
  }

  /** Why each session was last left alone, so the same sentence is not written every sweep. */
  readonly #lastReapReason = new Map<string, string>();

  #scheduleReap(session: Session): void {
    /**
     * A session whose process is already gone has nothing left to schedule.
     *
     * `exited` may only become `reaped`, so asking for `expiring` threw. That mattered more than
     * a stray warning: this runs in a loop over every session from `forgetReporter` and from the
     * sweep, and the throw came out of a socket close handler, so one exited session stopped the
     * loop and every session after it kept whatever timer it already had. Twenty nine of these in
     * one day on a real machine.
     */
    /**
     * Only a session that is actually idle may be put on a clock.
     *
     * Stated as what is allowed rather than what is not. `expiring` is reachable only from
     * `detached`, and this excluded terminal states alone, so a session still in `starting`
     * threw: created, not yet attached, and caught by a sweep or by a reporter going away. The
     * throw came out of a loop over every session, so one session in that window stopped every
     * session after it from being reconsidered, which is the same shape as the `exited` case this
     * guard was originally written for.
     *
     * Found by the model test rather than by reasoning, and made more likely by the daemon's own
     * sweep, which asks this question on a timer instead of only when a browser speaks.
     */
    if (session.state !== 'detached' && session.state !== 'expiring') return;

    // Any previous timer is void: this is a fresh decision, and leaving the old one running
    // would end a session whose tab has since come back. The **deadline** it was counting to is
    // kept separately and only discarded below, once the new decision is known.
    if (session.reapTimer) {
      clearTimeout(session.reapTimer);
      delete session.reapTimer;
    }

    const decision = decideReap(
      reapInputFor(session, {
        inWorkspace: this.#inWorkspace(session.id),
        sharesWorkspace: this.#sharesWorkspace(session.id),
        closedPaneSecondsLeft: this.undoWindowLeft?.(session.id) ?? null,
        paneClosedByUser: session.paneClosedByUser === true,
        listeningPort: session.listeningPort,
        keepBackgroundSeconds: this.keepBackgroundSeconds,
        tabDisposition: this.#tabDisposition(session.id),
      }),
      this.#config,
    );

    if (decision.afterSeconds === null) {
      /**
       * Said once, and again only when the reason changes.
       *
       * This runs on every sweep, for every session, and a session kept for a tab that is still
       * open is kept for that reason all day. Repeating it filled the log with two thousand
       * copies of the same sentence and rotated the events worth reading out of the file, which
       * is the opposite of what a log is for. A change of reason is news and is still recorded.
       */
      if (this.#lastReapReason.get(session.id) !== decision.reason) {
        this.#lastReapReason.set(session.id, decision.reason);
        info('session.reap.declined', { sessionId: session.id, reason: decision.reason });
      }
      delete session.reapDueAt;
      delete session.reapReason;
      /**
       * And it is not expiring any more, so it should stop saying it is.
       *
       * `expiring` means this terminal is going soon unless something changes. Something has
       * changed: the tab is back, or a server started listening, or the timeout was set to
       * forever. Without this the session kept that label for the rest of its life, having been
       * told it was safe, which is a thing the person is shown and other rules read.
       */
      if (session.state === 'expiring') this.#transition(session, 'detached');
      return;
    }
    this.#lastReapReason.delete(session.id);

    /**
     * The deadline, kept across re-decisions that reach the same conclusion.
     *
     * A different reason is a different clock and starts again. The same reason is the same
     * circumstance continuing, and restarting there is what made a thirty minute timeout
     * unreachable behind a two minute report.
     */
    const decidedAt = Date.now();
    if (session.reapReason !== decision.reason || session.reapDueAt === undefined) {
      session.reapReason = decision.reason;
      session.reapDueAt = decidedAt + decision.afterSeconds * 1000;
    }
    const remainingMs = Math.max(0, session.reapDueAt - decidedAt);

    const timer = setTimeout(() => {
      /**
       * Decided again, at the moment of acting.
       *
       * The first decision was made when the timer was set, and a great deal can happen in half
       * an hour: the tab can come back, another browser can report it, the timeout can be
       * changed, a server can start listening in it. The worst case is the ordinary one. A
       * laptop closed for the night wakes with every timer overdue, and they all fire at once,
       * before Chrome has started and said which tabs it has. Acting on a half-hour-old answer
       * there ends terminals whose tabs are sitting open on the screen the person is looking at.
       *
       * So the timer only means "look again", and a session is ended only if the policy still
       * says so with everything known now. When it does not, it is simply rescheduled.
       */
      const now = decideReap(
        reapInputFor(session, {
          inWorkspace: this.#inWorkspace(session.id),
          sharesWorkspace: this.#sharesWorkspace(session.id),
          closedPaneSecondsLeft: this.undoWindowLeft?.(session.id) ?? null,
          paneClosedByUser: session.paneClosedByUser === true,
          listeningPort: session.listeningPort,
          keepBackgroundSeconds: this.keepBackgroundSeconds,
          tabDisposition: this.#tabDisposition(session.id),
        }),
        this.#config,
      );
      if (now.afterSeconds === null) {
        info('session.reap.cancelled', {
          sessionId: session.id,
          was: decision.reason,
          now: now.reason,
        });
        delete session.reapTimer;
        delete session.reapDueAt;
        delete session.reapReason;
        this.#transition(session, 'detached');
        return;
      }
      info('session.reaping', { sessionId: session.id, reason: now.reason });
      /**
       * The evidence, read again now rather than trusted from when the timer was set.
       *
       * A timer means "look again", so the authorization is fetched at the moment of use and
       * carried into the record of what was done. If it has gone, so has the permission.
       */
      /**
       * The cause has to be the proof that exists, and if none does, nothing happens.
       *
       * This used to end with an unconditional `expired-after-pane-close`, which meant a
       * workspace timeout that could not name its own authorization borrowed the provenance of a
       * pane close that had never happened. A cause is supposed to be the evidence; a fallback
       * cause is a lie in the one record that says why a terminal was ended.
       *
       * So each branch asks for its own proof, and the last word is to cancel.
       */
      const workspaceId = this.#workspaceOf?.(session.id);
      if (workspaceId !== undefined) {
        const evidence = this.closeEvidence(workspaceId);
        if (evidence !== undefined) {
          void this.terminate(session, {
            kind: 'expired-after-tab-close',
            workspaceId,
            closeEventId: evidence.eventId,
            closedAt: evidence.at,
            keepHistory: true,
          });
          return;
        }
        // No close message, so the only remaining proof is a settled browser that does not have
        // it. `decideReap` above has already required exactly that, and re-required it just now.
        if (this.#tabDisposition(session.id) === 'closed') {
          void this.terminate(session, {
            kind: 'expired-after-window-close',
            workspaceId,
            keepHistory: true,
          });
          return;
        }
        this.#cancelUnauthorized(session, workspaceId);
        return;
      }

      // Outside every workspace, and the only thing that authorizes ending one of those is a
      // person having closed its pane.
      if (session.paneClosedByUser === true) {
        void this.terminate(session, { kind: 'expired-after-pane-close', keepHistory: true });
        return;
      }
      this.#cancelUnauthorized(session, 'none');
    }, remainingMs);
    // Unref'd: a session waiting to be reaped must not be the reason the process stays alive.
    // The wait is minutes long, so without this a daemon told to stop would sit there until a
    // timer nobody is waiting for happened to fire.
    timer.unref();
    session.reapTimer = timer;
    /**
     * A week away is not expiring.
     *
     * `expiring` is what a person is shown and what other rules read: it means this terminal is
     * going soon unless something changes. The abandonment horizon is a backstop measured in
     * days, for a browser that stopped existing, and marking every unreported session as
     * expiring the moment Chrome closes would say something untrue about all of them.
     */
    this.#transition(session, 'expiring');
    debug('session.reap.scheduled', { sessionId: session.id, policy: describeReap(decision) });
  }

  /** Whether a session is a pane in a workspace. Injected, so the manager owns no layout state. */
  #inWorkspace(sessionId: string): boolean {
    return this.isInWorkspace?.(sessionId) ?? false;
  }

  /**
   * Whether the session shares its workspace with other panes.
   *
   * An arrangement somebody built is work even when a given pane in it has not been typed into,
   * which is what the never-used rule would otherwise decide for it. See `cleanup.ts`.
   */
  #sharesWorkspace(sessionId: string): boolean {
    return (this.panesInItsWorkspace?.(sessionId) ?? 0) > 1;
  }

  /** Set by the daemon once the workspace store exists. */
  isInWorkspace?: (sessionId: string) => boolean;

  /** Set by the daemon once the workspace store exists. 0 when the session is in no workspace. */
  panesInItsWorkspace?: (sessionId: string) => number;

  /**
   * Seconds left in which a closed pane can still be brought back, or null when it is not one.
   *
   * Injected for the same reason as the two above: the manager owns sessions, and which pane was
   * closed a moment ago is something the server knows.
   */
  undoWindowLeft?: (sessionId: string) => number | null;

  #transition(session: Session, to: SessionState): void {
    if (session.state === to) return;
    assertTransition(session.state, to);
    session.state = to;
    this.#events.onStateChange(session);
  }

  /** Exactly once, whichever end arrives first. */
  #announceExit(session: Session): void {
    if (session.exitAnnounced === true) return;
    session.exitAnnounced = true;
    this.#events.onExit(session);
  }

  #reap(session: Session): void {
    if (session.reapTimer) clearTimeout(session.reapTimer);
    if (session.state !== 'reaped') {
      if (session.state !== 'exited') {
        try {
          this.#transition(session, 'exited');
        } catch {
          /* already terminal */
        }
      }
      try {
        this.#transition(session, 'reaped');
      } catch {
        /* already reaped */
      }
    }
    session.vt.dispose();
    session.clients.clear();
    this.#sessions.delete(session.id);
    this.#lastReapReason.delete(session.id);

    /**
     * Tell everyone else, exactly as a process ending does.
     *
     * This was missing, and the consequence was not obvious: reaping removed the session from
     * the map, so the exit event that arrives later from the PTY host found nothing and did
     * nothing, and the workspace was never told its pane had gone. The workspace then outlived
     * its session, and a tab reopened on it attached to a session that did not exist and
     * rendered nothing at all: no terminal, no start screen, and not even the page that says
     * the session expired.
     */
    this.#announceExit(session);
    info('session.reaped', { sessionId: session.id });
  }

  /**
   * The daemon is stopping.
   *
   * This used to kill every PTY, which meant every update destroyed every terminal and every
   * screen of output. It now hands the decision to the backend: the host keeps them running,
   * and only the in-process fallback ends them, because those are children of a process that is
   * about to not exist. See docs/adr/0017.
   */
  async shutdown(): Promise<void> {
    this.#pty.close();
    await Promise.resolve();
  }
}

/** Plain words for how a process ended, because an exit code alone tells most people nothing. */
function describeExit(exitCode: number, signal?: number): string {
  if (signal !== undefined && signal !== 0) return `killed by signal ${String(signal)}`;
  return exitCode === 0 ? 'finished' : `exited with code ${String(exitCode)}`;
}
