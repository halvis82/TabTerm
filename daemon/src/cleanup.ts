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
  | 'no-report'
  | 'in-a-workspace'
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
  hasOpenTab: boolean | null;
  /** Workspaces are pinned by default, so a pane in one is never reaped. See ADR-0012. */
  inWorkspace: boolean;
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
}

/** Long enough that reopening an accidentally closed tab still finds it. */
const NEVER_USED_SECONDS = 30;

export function decideReap(input: ReapInput, config: Config): ReapDecision {
  // Order matters: the first matching rule wins, and the most protective rules come first.
  if (input.pinned) return { afterSeconds: null, reason: 'pinned' };
  if (input.persistent) return { afterSeconds: null, reason: 'persistent' };
  if (input.attachedClients > 0) return { afterSeconds: null, reason: 'still-attached' };

  /**
   * A tab exists for it, so it stays. No timer, no exceptions.
   *
   * A backgrounded tab, a tab in a collapsed group, and a tab Chrome has discarded to save
   * memory all look identical from here: no socket. None of them means the person is done with
   * that terminal, and ending one is the single worst thing this product can do.
   */
  if (input.hasOpenTab === true) return { afterSeconds: null, reason: 'tab-open' };

  /**
   * Nobody could tell us, so we do not act.
   *
   * Chrome is closed, or crashed, or the extension has not reported yet. Every one of those is
   * a gap in what we know rather than evidence that a tab was closed, and the only safe reading
   * of "I do not know" is to keep the terminal. Chrome comes back and says what it has.
   */
  if (input.hasOpenTab === null) return { afterSeconds: null, reason: 'no-report' };

  /**
   * A pane in a workspace, with no tab showing it.
   *
   * This used to be kept forever, from ADR-0012, so that closing a tab could never destroy
   * work. That was right when a daemon restart cleaned house anyway. Sessions now survive
   * restarts, crashes and updates, so "forever" became literal and they accumulated into the
   * hundreds. It is a setting instead, and keeping them forever is still available by choosing
   * it rather than by default.
   */
  if (input.inWorkspace) {
    /**
     * A pane that was opened and closed without being used holds nothing.
     *
     * Inside the workspace branch rather than before it, so it can only ever make a pane go
     * sooner than the background timeout and never delay one that some other rule would have
     * ended faster. Not immediate: a few seconds means closing a tab by accident is still
     * recoverable by reopening it, and nothing accumulates.
     */
    if (input.neverUsed && input.listeningPort === undefined && !input.hasExplicitCommand) {
      return { afterSeconds: NEVER_USED_SECONDS, reason: 'never-used' };
    }
    /**
     * The tab has actually been closed, which is the only case that starts a clock.
     *
     * Half an hour by default: long enough that closing a tab by mistake costs nothing, short
     * enough that a day of work does not leave fifty shells behind.
     */
    return input.keepBackgroundSeconds === null
      ? { afterSeconds: null, reason: 'in-a-workspace' }
      : { afterSeconds: input.keepBackgroundSeconds, reason: 'tab-closed' };
  }

  // A process that already ended holds nothing worth keeping, so its metadata goes quickly.
  if (input.exited) return { afterSeconds: 5, reason: 'process-exited' };

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
    listeningPort?: number | undefined;
    keepBackgroundSeconds?: number | null;
    hasOpenTab?: boolean | null;
  },
): ReapInput {
  return {
    pinned: session.pinned,
    persistent: session.persistent ?? false,
    attachedClients: session.clients.size,
    hasOpenTab: opts.hasOpenTab ?? null,
    inWorkspace: opts.inWorkspace,
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
  };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
