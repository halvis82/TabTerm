import type { LayoutNode, Workspace } from '@tabterm/shared';
import { closePane, panes } from '@tabterm/shared';
import { homedir } from 'node:os';
import type { Database } from './database.js';
import { debug, info } from './log.js';

/**
 * What survives a macOS restart.
 *
 * Nothing that is a process does. That is a hard limit, not a design choice: a PTY dies with
 * the machine, and any product claiming otherwise is lying. See docs/10-limitations.md tier 0.3.
 *
 * Everything else can survive, and the gap between "your tabs are gone" and "here is the layout
 * you had, in the same directories, with what you last ran in each" is the entire value of this
 * file. It stores layout, per-pane directory, last command, and a screen snapshot, and hands
 * them back as an *offer*.
 *
 * See docs/04-session-lifecycle.md §11.
 */

export interface PaneSnapshot {
  paneId: string;
  sessionId: string;
  cwd: string;
  lastCommand?: string;
  /** The explicit argv a pane was started with, if any. */
  command?: readonly string[];
  /** An agent session id that could be resumed into this pane. */
  agentResume?: string;
  /** The screen as it was, so a restored pane can show what was there before. */
  screen: string;
  savedAt: number;
}

export interface RestorableWorkspace {
  workspaceId: string;
  layout: LayoutNode;
  panes: readonly PaneSnapshot[];
  savedAt: number;
}

/** Enough to be recognisable, small enough that a dozen of them are not a burden. */
const MAX_SCREEN_BYTES = 64 * 1024;

export class RestoreStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Record a workspace as it currently is.
   *
   * Called whenever a layout changes and on shutdown, rather than on a timer. A workspace that
   * has not changed does not need saving again, and a timer would write constantly for nothing.
   */
  save(
    workspace: Workspace,
    paneData: (sessionId: string) => Omit<PaneSnapshot, 'paneId' | 'sessionId' | 'savedAt'> | null,
  ): void {
    const now = Date.now();
    this.#db.handle
      .prepare(
        `INSERT INTO workspaces (id, layout_json, pinned, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at,
           closed_at = NULL`,
      )
      .run(workspace.id, JSON.stringify(workspace.layout), workspace.createdAt, now);

    const insert = this.#db.handle.prepare(
      `INSERT INTO pane_snapshots (workspace_id, pane_id, session_id, cwd, last_command, command_json, agent_resume, screen, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, pane_id) DO UPDATE SET
         session_id = excluded.session_id, cwd = excluded.cwd,
         last_command = COALESCE(excluded.last_command, last_command),
         command_json = excluded.command_json,
         agent_resume = COALESCE(excluded.agent_resume, agent_resume),
         -- An empty screen never overwrites one that was captured. A pane whose renderer was
         -- already gone must not erase what was recorded while it was alive.
         screen = CASE WHEN excluded.screen = '' THEN screen ELSE excluded.screen END,
         saved_at = excluded.saved_at`,
    );

    const live = new Set<string>();
    for (const { paneId, sessionId } of panes(workspace.layout)) {
      const data = paneData(sessionId);
      if (!data) continue;
      live.add(paneId);
      insert.run(
        workspace.id,
        paneId,
        sessionId,
        data.cwd,
        data.lastCommand ?? null,
        data.command ? JSON.stringify(data.command) : null,
        data.agentResume ?? null,
        data.screen.slice(-MAX_SCREEN_BYTES),
        now,
      );
    }

    // Panes that left the layout stop being restorable. Otherwise a closed pane would come back
    // every restart, which is the opposite of what closing it meant.
    const stale = this.#db.handle
      .prepare('SELECT pane_id FROM pane_snapshots WHERE workspace_id = ?')
      .all(workspace.id) as { pane_id: string }[];
    for (const row of stale) {
      if (!live.has(row.pane_id)) {
        this.#db.handle
          .prepare('DELETE FROM pane_snapshots WHERE workspace_id = ? AND pane_id = ?')
          .run(workspace.id, row.pane_id);
      }
    }
    debug('restore.saved', { workspaceId: workspace.id, panes: live.size });
  }

  /** Forget a workspace entirely, for one the user deliberately closed. */
  forget(workspaceId: string): void {
    this.#db.handle.prepare('DELETE FROM pane_snapshots WHERE workspace_id = ?').run(workspaceId);
    this.#db.handle.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
  }

  /**
   * Workspaces that could be brought back, newest first.
   *
   * `excludeLive` is the set already running. After a daemon restart that is empty and
   * everything is offered; during normal operation it is everything, and nothing is, which is
   * exactly right — restore is for the case where the sessions are gone.
   */
  list(excludeLive: ReadonlySet<string>, limit = 12): RestorableWorkspace[] {
    const rows = this.#db.handle
      .prepare(
        `SELECT id, layout_json, updated_at FROM workspaces
         WHERE closed_at IS NULL
         -- rowid breaks a tie, because two workspaces saved in the same millisecond would
         -- otherwise come back in whatever order SQLite felt like.
         ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit * 2) as { id: string; layout_json: string; updated_at: number }[];

    const out: RestorableWorkspace[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (excludeLive.has(row.id)) continue;
      let layout: LayoutNode;
      try {
        layout = JSON.parse(row.layout_json) as LayoutNode;
      } catch {
        // A layout that will not parse is not worth a crash on startup. Skipping it costs one
        // restore offer; throwing would cost the daemon.
        continue;
      }
      const all = this.#panesFor(row.id);
      if (all.length === 0) continue;

      /**
       * Only the panes that hold something, and the shape is forgotten with the rest.
       *
       * A layout of three untouched shells in the home directory has nothing in it to reopen,
       * and was being offered as "3 panes" every time. One that had work in one pane and two
       * empty ones was offering to rebuild two shells nobody had used. What is worth bringing
       * back is the work, so the empty panes are pruned and the layout is pruned with them; if
       * that leaves nothing, the whole offer goes.
       */
      const snapshots = all.filter((pane) => !isEmptyPane(pane));
      if (snapshots.length === 0) continue;
      const kept = new Set(snapshots.map((p) => p.paneId));
      for (const pane of all) {
        if (kept.has(pane.paneId)) continue;
        const pruned = closePane(layout, pane.paneId);
        if (pruned === null) break;
        layout = pruned;
      }

      // Identical layouts collapse to the newest. A daemon that restarted a dozen times leaves
      // a dozen indistinguishable records, and offering the same thing twelve times is worse
      // than offering it once: it buries everything that is actually different.
      const signature = snapshots.map((p) => `${p.cwd}|${p.lastCommand ?? ''}`).join('\n');
      if (seen.has(signature)) continue;
      seen.add(signature);

      out.push({ workspaceId: row.id, layout, panes: snapshots, savedAt: row.updated_at });
      if (out.length >= limit) break;
    }
    return out;
  }

  get(workspaceId: string): RestorableWorkspace | null {
    const row = this.#db.handle
      .prepare('SELECT id, layout_json, updated_at FROM workspaces WHERE id = ?')
      .get(workspaceId) as { id: string; layout_json: string; updated_at: number } | undefined;
    if (!row) return null;
    try {
      return {
        workspaceId: row.id,
        layout: JSON.parse(row.layout_json) as LayoutNode,
        panes: this.#panesFor(row.id),
        savedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  #panesFor(workspaceId: string): PaneSnapshot[] {
    const rows = this.#db.handle
      .prepare(
        `SELECT pane_id, session_id, cwd, last_command, command_json, agent_resume, screen, saved_at
         FROM pane_snapshots WHERE workspace_id = ? ORDER BY pane_id`,
      )
      .all(workspaceId) as {
      pane_id: string;
      session_id: string;
      cwd: string;
      last_command: string | null;
      command_json: string | null;
      agent_resume: string | null;
      screen: string;
      saved_at: number;
    }[];

    return rows.map((r) => ({
      paneId: r.pane_id,
      sessionId: r.session_id,
      cwd: r.cwd,
      screen: r.screen,
      savedAt: r.saved_at,
      ...(r.last_command ? { lastCommand: r.last_command } : {}),
      ...(r.agent_resume ? { agentResume: r.agent_resume } : {}),
      ...argvField(r.command_json),
    }));
  }

  /** Drop everything older than the retention window, so this cannot grow without bound. */
  prune(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    const removed = this.#db.handle
      .prepare('DELETE FROM workspaces WHERE updated_at < ?')
      .run(cutoff);
    this.#db.handle
      .prepare('DELETE FROM pane_snapshots WHERE workspace_id NOT IN (SELECT id FROM workspaces)')
      .run();
    if (removed.changes > 0) info('restore.pruned', { workspaces: Number(removed.changes) });
  }
}

/**
 * Whether a workspace is worth offering back.
 *
 * One pane, sitting in the home directory, having never run anything, is exactly what opening a
 * new tab gives you. Restoring it restores nothing, and a list of them buries the workspaces
 * that do carry something back.
 */
/**
 * A pane nobody used: no command run in it, none staged for it, and never moved from home.
 *
 * The same question `isTrivial` asked about a single-pane workspace, asked of one pane, so a
 * layout of several is judged by the same rule rather than escaping it by being bigger.
 */
function isEmptyPane(pane: PaneSnapshot): boolean {
  if (pane.lastCommand || (pane.command?.length ?? 0) > 0) return false;
  return pane.cwd === homedir();
}

/** Present only when it parsed, so an unusable value never becomes an empty command. */
function argvField(json: string | null): { command?: readonly string[] } {
  if (!json) return {};
  const argv = safeParseArgv(json);
  return argv ? { command: argv } : {};
}

/** A stored argv that will not parse is treated as absent rather than as a crash. */
function safeParseArgv(json: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed;
    }
  } catch {
    /* not usable */
  }
  return undefined;
}
