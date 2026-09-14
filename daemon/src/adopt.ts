import type { LayoutNode } from '@tabterm/shared';
import type { Database } from './database.js';
import { info, warn } from './log.js';
import { safeError } from './safe-error.js';

/**
 * Taking over sessions that were already running when this daemon started.
 *
 * The PTY host keeps processes alive across a daemon restart, which is only half the promise.
 * The other half is that a tab reconnects to the same terminal rather than being told it
 * expired, and that needs the metadata the host does not have and should not: which directory a
 * session belongs to, which workspace it is a pane of, and how that workspace was laid out.
 *
 * All of it is already on disk, written during normal operation. Adoption is a read.
 * See docs/adr/0017 and docs/04-session-lifecycle.md.
 */

export interface AdoptableSession {
  sessionId: string;
  pid: number;
  cwd: string;
  seq: number;
  /**
   * When the host started this process, which outlives every daemon that has watched it.
   *
   * Carried through because the daemon has no other way to know how old an adopted session is,
   * and treating one as new on every restart resets the clock that decides when a session
   * nobody has claimed in weeks is finally let go. A restart happens on every update, so that
   * clock would never have run out on a machine that keeps itself current.
   */
  startedAt?: number;
  /**
   * The size the terminal is really running at, which the host has held all along.
   *
   * The daemon rebuilds each screen by replaying output into a fresh emulator, and an emulator of
   * the wrong width wraps every line in the wrong place. Without this, every restart rebuilt
   * every screen at eighty columns while the terminals themselves carried on at whatever they
   * were, and a reattaching tab was handed a folded-up copy of its own screen.
   */
  cols?: number;
  rows?: number;
  hasInput?: boolean;
  paneClosedByUser?: boolean;
}

export interface AdoptionPlan {
  sessions: {
    sessionId: string;
    pid: number;
    cwd: string;
    shell: string;
    command?: readonly string[];
    workspaceId?: string;
    startedAt?: number;
    /** The size it is running at, when the host knows it. See `AdoptableSession`. */
    cols?: number;
    rows?: number;
    /** Somebody typed into it, which only the host remembers across a daemon restart. */
    hasInput?: boolean;
    /** A person closed its pane, which only the host remembers across a daemon restart. */
    paneClosedByUser?: boolean;
  }[];
  workspaces: { id: string; layout: LayoutNode }[];
}

/**
 * Work out what can be taken over, from what the host has and what the database remembers.
 *
 * A session the database has never heard of is still adopted, with the host's own idea of its
 * directory. Losing a running process because a metadata row is missing would be a poor trade,
 * and a terminal with a slightly wrong title is still a terminal.
 */
export function planAdoption(
  live: readonly AdoptableSession[],
  db: Database,
  defaultShell: string,
): AdoptionPlan {
  if (live.length === 0) return { sessions: [], workspaces: [] };

  const plan: AdoptionPlan = { sessions: [], workspaces: [] };
  const wanted = new Set<string>();

  for (const session of live) {
    const row = db.handle
      .prepare('SELECT workspace_id, cwd, shell, command_json FROM session_meta WHERE id = ?')
      .get(session.sessionId) as
      | { workspace_id: string | null; cwd: string; shell: string; command_json: string | null }
      | undefined;

    let command: readonly string[] | undefined;
    if (row?.command_json) {
      try {
        const parsed: unknown = JSON.parse(row.command_json);
        if (Array.isArray(parsed)) command = parsed as string[];
      } catch {
        // A row we cannot read is not a reason to drop a running process.
      }
    }

    plan.sessions.push({
      sessionId: session.sessionId,
      pid: session.pid,
      ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
      cwd: row?.cwd ?? session.cwd,
      shell: row?.shell ?? defaultShell,
      ...(command ? { command } : {}),
      ...(row?.workspace_id ? { workspaceId: row.workspace_id } : {}),
      ...(session.cols !== undefined && session.rows !== undefined
        ? { cols: session.cols, rows: session.rows }
        : {}),
      // This is rebuilt field by field rather than spread, so anything not named here is
      // dropped. That is how the size used to be lost.
      ...(session.hasInput === true ? { hasInput: true } : {}),
      ...(session.paneClosedByUser === true ? { paneClosedByUser: true } : {}),
    });
    if (row?.workspace_id) wanted.add(row.workspace_id);
  }

  for (const id of wanted) {
    const row = db.handle.prepare('SELECT layout_json FROM workspaces WHERE id = ?').get(id) as
      { layout_json: string } | undefined;
    if (!row) continue;
    try {
      plan.workspaces.push({ id, layout: JSON.parse(row.layout_json) as LayoutNode });
    } catch {
      warn('adopt.layout-unreadable', { workspaceId: id });
    }
  }

  info('adopt.planned', { sessions: plan.sessions.length, workspaces: plan.workspaces.length });
  return plan;
}

/**
 * Panes in a layout whose session is not among those still running.
 *
 * A workspace can be adopted with some panes alive and some gone, which happens whenever one
 * pane's shell exited before the restart. Those panes are dropped rather than restored as dead
 * ones, because a pane that can never produce output is worse than an absent pane.
 */
export function prunePanes(layout: LayoutNode, alive: ReadonlySet<string>): LayoutNode | null {
  if (layout.type === 'terminal') return alive.has(layout.sessionId) ? layout : null;
  const first = prunePanes(layout.children[0], alive);
  const second = prunePanes(layout.children[1], alive);
  if (first && second) return { ...layout, children: [first, second] };
  return first ?? second;
}

/**
 * What adoption needs, and nothing else.
 *
 * Structural on purpose: the real ones are the session manager, the workspace store, the host
 * backend and the host client, and naming only the four calls that are made keeps this testable
 * with plain objects rather than a daemon.
 */
export interface AdoptionDeps {
  /** What the host says is still running. */
  adoptable(): Promise<readonly AdoptableSession[]>;
  /**
   * Ask the host for a session's output from a position, so the screen can be rebuilt.
   *
   * What it answers with is the caller's business. The host reports how much it could not hand
   * back, and the daemon turns that into a line in the session itself; adoption only has to wait
   * for it, because the bytes have to land in a VT that exists.
   */
  replay(sessionId: string, from: number): Promise<unknown>;
  /** Take a running process over, and say which session it became. */
  adopt(entry: AdoptionPlan['sessions'][number] & { cols: number; rows: number }): {
    id: string;
  };
  /** Put a workspace back, with the panes that survived. */
  hydrate(workspace: { id: string; layout: LayoutNode }): void;
  /** Say that catching up is finished, so held output is delivered. */
  reconciled(): void;
}

/**
 * Take over everything that was already running, and say so when it is done.
 *
 * Extracted from the daemon's startup because of what was missing rather than for tidiness. The
 * call that says catching up is over sat inside `if (live.length > 0)`, so a daemon that started
 * with nothing to adopt never said it, which is every first start after a reboot, after a Reset,
 * and every browser run.
 *
 * Two things followed, and the second is the one that reached a person:
 *
 * - A warning on every healthy start. A log that cries wolf on a normal morning is a log nobody
 *   reads on the morning it matters
 * - **Five seconds of held output.** A connection holds live frames until it is told it has caught
 *   up, so a terminal opened inside that window drew nothing until the safety net fired. The
 *   daemon and Chrome race at login by design, which is exactly when somebody opens the first one
 *
 * So it is said on every path out of here, including the failing one. Saying it twice is harmless
 * and saying it never is not.
 */
export async function adoptEverything(
  deps: AdoptionDeps,
  db: Database,
  defaultShell: string,
): Promise<{ sessions: number; workspaces: number }> {
  try {
    const live = await deps.adoptable();
    if (live.length === 0) return { sessions: 0, workspaces: 0 };

    const plan = planAdoption(live, db, defaultShell);
    const adopted = new Set<string>();
    for (const entry of plan.sessions) {
      /**
       * Adopted at the size it is really running at, not at eighty by twenty-four.
       *
       * The screen is rebuilt by replaying the host's output into a fresh emulator, and an
       * emulator of the wrong width wraps every line in the wrong place. Every restart used to
       * rebuild every screen at eighty columns while the terminals themselves carried on at
       * whatever they were, so a reattaching tab was handed a folded-up copy of its own screen
       * and a full-screen program had to be resized before it looked right again.
       */
      const session = deps.adopt({ ...entry, cols: entry.cols ?? 80, rows: entry.rows ?? 24 });
      adopted.add(session.id);
    }
    for (const workspace of plan.workspaces) {
      const layout = prunePanes(workspace.layout, adopted);
      if (layout) deps.hydrate({ id: workspace.id, layout });
    }
    // Replay after the sessions exist, so the bytes land in a VT that is listening.
    for (const entry of plan.sessions) await deps.replay(entry.sessionId, 0);

    info('adopt.complete', { sessions: adopted.size, workspaces: plan.workspaces.length });
    return { sessions: adopted.size, workspaces: plan.workspaces.length };
  } catch (e: unknown) {
    // Adoption is an optimization over "the session expired". Failing it must never stop the
    // daemon from serving, because then a bad row would cost you every terminal.
    warn('adopt.failed', { error: safeError(e) });
    return { sessions: 0, workspaces: 0 };
  } finally {
    // The first connection has caught up too: adoption is the same situation as a reconnect,
    // with the whole history as the gap. Nothing to adopt is still caught up.
    deps.reconciled();
  }
}
