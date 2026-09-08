import type { Config } from './config.js';
import type { Session } from './session-manager.js';

/**
 * When a detached session may be reaped, and why.
 *
 * Separated from the session manager and made pure so the policy can be reasoned about and
 * tested on its own. Every decision carries its reason, because a session vanishing without an
 * explanation is indistinguishable from a bug. See docs/04-session-lifecycle.md §4.
 */

export type ReapReason =
  | 'never-used'
  | 'tab-closed'
  | 'pinned'
  | 'persistent'
  | 'still-attached'
  | 'tab-open'
  | 'no-close-evidence'
  | 'in-a-workspace'
  | 'closed-pane'
  | 'server-listening'
  | 'process-exited'
  | 'long-lived-program'
  | 'idle-shell'
  | 'default';

export interface ReapDecision {
  /** null means never reap on a timer. */
  afterSeconds: number | null;
  reason: ReapReason;
}

/**
 * What is known about the tab a workspace lives in.
 *
 * `closed` is the only one that can authorize an automatic ending, and it is only ever produced
 * by explicit evidence that somebody closed that specific tab. Everything else is `unknown`, and
 * unknown keeps the terminal.
 */
export type TabDisposition = 'open' | 'closed' | 'unknown';

export interface ReapInput {
  pinned: boolean;
  persistent: boolean;
  attachedClients: number;
  /**
   * Does a Chrome tab for this session still exist?
   *
   * `true` a tab is open, `false` there is none, **`null` nobody could tell us**. The daemon
   * cannot see Chrome, so this is reported by the extension, which can.
   *
   * The three-way answer is the whole point. A session was once reaped while its tab was
   * plainly open: the tab had been discarded or the machine had slept, the socket went with it,
   * and `attachedClients` fell to zero. A connection is evidence that somebody is looking right
   * now; it is not evidence that the tab is gone.
   */
  tabDisposition: TabDisposition;
  /**
   * Whether somebody deliberately closed this session's pane.
   *
   * The authorization for everything that happens to a session outside a workspace. A pane that
   * was closed and whose undo window has run out is a person saying they are finished with it; a
   * session that is simply not in a workspace any more is not.
   */
  paneClosedByUser: boolean;
  /** Workspaces are pinned by default, so a pane in one is never reaped. See ADR-0012. */
  inWorkspace: boolean;
  /** Whether other panes share its workspace, which makes it part of an arrangement. */
  sharesWorkspace: boolean;
  exited: boolean;
  /** A session holding a listening socket is almost certainly a dev server someone wants. */
  listeningPort?: number | undefined;
  foregroundProgram?: string | undefined;
  hasExplicitCommand: boolean;
  /** How long a pane with no tab is kept, or null to keep it forever. */
  keepBackgroundSeconds: number | null;
  /**
   * Nothing has ever been run here and it never left the directory it opened in.
   *
   * A tab opened and closed without being used is not work somebody might come back to, and
   * keeping it for the background timeout is how a machine ends up holding dozens of identical
   * shells in the home directory.
   */
  neverUsed: boolean;
  /**
   * Seconds left in which a pane somebody closed can still be brought back, or null.
   *
   * Closing a pane used to end its shell on the spot, which made the gesture unrecoverable and
   * therefore something to be careful with. It is held for a few minutes instead, which is what
   * makes an undo possible, and this is the rule that keeps it alive for exactly that long: it
   * belongs to no workspace during the wait, so without it the rules for a homeless shell would
   * end it in seconds.
   */
  closedPaneSecondsLeft?: number | null;
  /**
   * How long since anything was attached to this session.
   *
   * Only consulted when nobody can speak for it at all. A tab that is open but disconnected is
   * protected by an earlier rule, so this cannot be read as "your tab has been in the background
   * a long time".
   */
  detachedForSeconds: number;
}

/** Long enough that reopening an accidentally closed tab still finds it. */
const NEVER_USED_SECONDS = 30;

export function decideReap(input: ReapInput, config: Config): ReapDecision {
  // Order matters: the first matching rule wins, and the most protective rules come first.
  if (input.pinned) return { afterSeconds: null, reason: 'pinned' };
  if (input.persistent) return { afterSeconds: null, reason: 'persistent' };
  if (input.attachedClients > 0) return { afterSeconds: null, reason: 'still-attached' };

  /**
   * A pane somebody closed, waiting to see whether they meant it.
   *
   * Ahead of everything below because it is a decision that has already been made explicitly and
   * has a deadline of its own: it is in no workspace and no tab shows it, which every rule below
   * reads as "end this", correctly and far too soon.
   */
  const closing = input.closedPaneSecondsLeft;
  if (closing !== undefined && closing !== null) {
    return { afterSeconds: Math.max(0, closing), reason: 'closed-pane' };
  }

  /**
   * A tab exists for it, so it stays. No timer, no exceptions.
   *
   * A backgrounded tab, a tab in a collapsed group, and a tab Chrome has discarded to save
   * memory all look identical from here: no socket. None of them means the person is done with
   * that terminal, and ending one is the single worst thing this product can do.
   */
  if (input.tabDisposition === 'open') return { afterSeconds: null, reason: 'tab-open' };

  /**
   * A session that is still a pane in a workspace lives or dies by that workspace's tab.
   *
   * Only `closed` gets it onto a clock, and `closed` is only ever produced by an explicit
   * statement that somebody closed that specific tab. Everything else in the world that stops a
   * workspace being reported, Chrome quitting, a window closing, a crash, an extension being
   * replaced, a discarded tab, a machine asleep, a socket dropping, a daemon restarting, a
   * second profile that never had it, a report that arrived late or empty, arrives here as
   * `unknown` and is kept.
   */
  if (input.inWorkspace) {
    if (input.tabDisposition !== 'closed') {
      return { afterSeconds: null, reason: 'no-close-evidence' };
    }
    /**
     * A pane that was opened and closed without being used holds nothing.
     *
     * Never for a pane that shares its workspace, because then it is part of an arrangement: an
     * extension reload closes every tab, and a pane in a template that has printed nothing but a
     * prompt is untouched by this rule's definition while being exactly the thing somebody spent
     * the morning arranging.
     */
    if (
      input.neverUsed &&
      !input.sharesWorkspace &&
      input.listeningPort === undefined &&
      !input.hasExplicitCommand
    ) {
      return { afterSeconds: NEVER_USED_SECONDS, reason: 'never-used' };
    }
    return input.keepBackgroundSeconds === null
      ? { afterSeconds: null, reason: 'in-a-workspace' }
      : { afterSeconds: input.keepBackgroundSeconds, reason: 'tab-closed' };
  }

  // A process that already ended holds nothing worth keeping, so its metadata goes quickly.
  // Nothing is signalled here: the process is gone, and this is the record of it being tidied.
  if (input.exited) return { afterSeconds: 5, reason: 'process-exited' };

  /**
   * Outside a workspace, and nobody closed anything. Keep it.
   *
   * Everything below this line ends a live process on a timer, and the branch is reached by two
   * very different routes. One is a pane somebody deliberately closed, whose undo window has run
   * out; that is an explicit act and it authorizes what follows. The other is a session that
   * stopped being in a workspace for some other reason, and for that there is no act at all.
   *
   * The rules below, an idle shell, a long-lived program, a default, are about **how long** to
   * wait once ending is authorized. They were never a grant of authorization, and reaching them
   * without one is how a session with nothing said about it could be ended on a clock.
   */
  if (!input.paneClosedByUser) {
    return { afterSeconds: null, reason: 'no-close-evidence' };
  }

  // Killing a running server because a tab closed would be the most annoying possible
  // behavior, so it is protected and the user is warned instead.
  if (input.listeningPort !== undefined) {
    return { afterSeconds: null, reason: 'server-listening' };
  }

  const program = basename(input.foregroundProgram ?? '');
  if (program && config.longLivedPrograms.includes(program)) {
    return { afterSeconds: config.reapAgentOrEditorSeconds, reason: 'long-lived-program' };
  }

  if (!input.hasExplicitCommand) {
    return { afterSeconds: config.reapIdleShellSeconds, reason: 'idle-shell' };
  }

  return { afterSeconds: config.reapDefaultSeconds, reason: 'default' };
}

export function describeReap(decision: ReapDecision): string {
  if (decision.afterSeconds === null) return `never (${decision.reason})`;
  return `${String(decision.afterSeconds)}s (${decision.reason})`;
}

export function reapInputFor(
  session: Session,
  opts: {
    inWorkspace: boolean;
    sharesWorkspace?: boolean;
    closedPaneSecondsLeft?: number | null;
    listeningPort?: number | undefined;
    keepBackgroundSeconds?: number | null;
    tabDisposition?: TabDisposition;
    paneClosedByUser?: boolean;
  },
): ReapInput {
  return {
    pinned: session.pinned,
    persistent: session.persistent ?? false,
    attachedClients: session.clients.size,
    /** Anything not said is not known, and not known keeps the terminal. */
    tabDisposition: opts.tabDisposition ?? 'unknown',
    /** Not said is not done, and not done keeps the terminal. */
    paneClosedByUser: opts.paneClosedByUser ?? false,
    inWorkspace: opts.inWorkspace,
    sharesWorkspace: opts.sharesWorkspace ?? false,
    closedPaneSecondsLeft: opts.closedPaneSecondsLeft ?? null,
    // Never used means never a command, and never anywhere but where it opened. A `cd` on its
    // own is a shell builtin that spawns nothing, so the directory is checked as well rather
    // than trusting the command flag alone.
    neverUsed: session.hasRun !== true && session.cwd === session.startedIn,
    exited: session.state === 'exited',
    listeningPort: opts.listeningPort,
    keepBackgroundSeconds:
      opts.keepBackgroundSeconds === undefined ? null : opts.keepBackgroundSeconds,
    foregroundProgram: session.foregroundProcess ?? session.command?.[0],
    hasExplicitCommand: Boolean(session.command),
    detachedForSeconds: Math.max(0, (Date.now() - session.lastAttachedAt) / 1000),
  };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
