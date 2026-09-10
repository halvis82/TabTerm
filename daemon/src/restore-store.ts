import type { LayoutNode, Workspace } from '@tabterm/shared';
import { closePane, panes } from '@tabterm/shared';
import { homedir } from 'node:os';
import type { Database } from './database.js';
import { debug, info, warn } from './log.js';
import { safeError } from './safe-error.js';

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
  /**
   * Which agent CLI was running here, if one was.
   *
   * Recorded so a restore can be honest about the specific thing somebody is looking at. A pane
   * that comes back showing a Claude conversation and a line saying only that the shell is new
   * is technically true and still misleading: the conversation is the thing on the screen, and
   * it is the thing that is not running.
   */
  agent?: string;
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
   * Remember which browser held a workspace, and when it went to the background.
   *
   * Both survive a daemon restart on purpose. Provenance is what lets a browser's report that a
   * workspace is gone mean anything at all, and a daemon that lost it would find every adopted
   * session unattributable and therefore unable ever to reach the timeout somebody chose. The
   * background time is the start of that timeout, and recomputing it on each daemon update would
   * quietly hand every session a fresh one.
   *
   * Written where the workspace already is, and best effort: a workspace this daemon has not
   * persisted yet simply has nowhere to record it, and the in-memory copy still works for as long
   * as this daemon runs.
   */
  noteOwner(workspaceId: string, profile: string): void {
    try {
      /*
       * Added to the set, not written over the last one.
       *
       * `owner_profile` holds whichever browser wrote most recently, and a workspace open in two
       * of them has two owners. That distinction decides whether a terminal is ended: one profile
       * that held a workspace and no longer lists it is enough to call it closed, so a second
       * profile that also held it and happens to be disconnected must be knowable. Overwriting
       * made its claim not merely unknown but gone.
       *
       * The old column is still written, because `tabterm doctor` and anything else reading the
       * workspaces table has not moved over and one of two owners is better there than none.
       */
      this.#db.handle
        .prepare('INSERT OR IGNORE INTO workspace_owners (workspace_id, profile) VALUES (?, ?)')
        .run(workspaceId, profile);
      this.#db.handle
        .prepare('UPDATE workspaces SET owner_profile = ? WHERE id = ?')
        .run(profile, workspaceId);
    } catch {
      /* provenance is an optimization over asking again; never a reason to fail a request */
    }
  }

  /** Every browser known to have held each workspace, for the rule that reads a browser's silence. */
  allOwners(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    try {
      const rows = this.#db.handle
        .prepare('SELECT workspace_id, profile FROM workspace_owners')
        .all() as { workspace_id: string; profile: string }[];
      for (const row of rows) {
        const seen = out.get(row.workspace_id) ?? new Set<string>();
        seen.add(row.profile);
        out.set(row.workspace_id, seen);
      }
    } catch {
      /* an unreadable table means no provenance, which is the same as a fresh machine */
    }
    return out;
  }

  /** When a workspace went to the background, or null when it came back. */
  noteBackgroundSince(workspaceId: string, at: number | null): void {
    try {
      this.#db.handle
        .prepare('UPDATE workspaces SET background_since = ? WHERE id = ?')
        .run(at, workspaceId);
    } catch {
      /* as above */
    }
  }

  /** What was remembered about every workspace, for seeding a daemon that has just started. */
  provenance(): {
    workspaceId: string;
    profile?: string;
    /** Every browser known to have held it. `profile` is one of these, kept for older readers. */
    profiles?: string[];
    backgroundSince?: number;
  }[] {
    try {
      const rows = this.#db.handle
        .prepare(
          `SELECT id, owner_profile, background_since FROM workspaces
           WHERE owner_profile IS NOT NULL OR background_since IS NOT NULL`,
        )
        .all() as { id: string; owner_profile: string | null; background_since: number | null }[];
      /*
       * Every owner of a workspace, not the last one recorded against it.
       *
       * The row carries one profile and a workspace can have several. Restoring only that one put
       * a daemon back with an incomplete idea of who had held what, which is the state that lets a
       * single ex-owner's silence end a terminal another browser still has open.
       */
      const owners = this.allOwners();
      const known = new Set(rows.map((r) => r.id));
      for (const id of owners.keys()) known.add(id);
      const byId = new Map(rows.map((r) => [r.id, r]));

      return [...known].map((id) => {
        const row = byId.get(id);
        const all = [...(owners.get(id) ?? [])];
        const primary = row?.owner_profile ?? all[0];
        return {
          workspaceId: id,
          ...(primary === undefined || primary === null ? {} : { profile: primary }),
          ...(all.length === 0 ? {} : { profiles: all }),
          ...(row === undefined || row.background_since === null
            ? {}
            : { backgroundSince: row.background_since }),
        };
      });
    } catch {
      return [];
    }
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
    /**
     * One snapshot, written whole or not at all.
     *
     * This writes three things that only mean something together: the layout, a row per pane in
     * it, and the removal of rows for panes that have left. Written separately, a crash partway
     * leaves a layout from now beside pane contents from before, and the next start restores a
     * workspace that never existed: a pane showing another pane's screen, or a layout with a
     * pane whose snapshot was already deleted.
     *
     * The live terminals are not at risk either way, because the host holds those. What is at
     * risk is the recovery after a reboot, and a recovery that restores a state nobody was ever
     * in is worse than one that restores the previous coherent state.
     */
    this.#db.handle.exec('BEGIN IMMEDIATE');
    try {
      this.#saveWithin(workspace, paneData);
      this.#db.handle.exec('COMMIT');
    } catch (e: unknown) {
      try {
        this.#db.handle.exec('ROLLBACK');
      } catch {
        /* the transaction was already resolved, which is the state we wanted anyway */
      }
      // Nothing is retried and nothing is thrown on. A snapshot that could not be written leaves
      // the previous coherent one in place, which is exactly the outcome this is protecting.
      warn('restore.save-failed', { workspaceId: workspace.id, error: safeError(e) });
    }
  }

  /** The body of `save`, run inside its transaction. */
  #saveWithin(
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
      `INSERT INTO pane_snapshots (workspace_id, pane_id, session_id, cwd, last_command, command_json, agent_resume, agent, screen, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, pane_id) DO UPDATE SET
         session_id = excluded.session_id, cwd = excluded.cwd,
         last_command = COALESCE(excluded.last_command, last_command),
         command_json = excluded.command_json,
         agent_resume = COALESCE(excluded.agent_resume, agent_resume),
         agent = COALESCE(excluded.agent, agent),
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
        data.agent ?? null,
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
        `SELECT pane_id, session_id, cwd, last_command, command_json, agent_resume, agent, screen, saved_at
         FROM pane_snapshots WHERE workspace_id = ? ORDER BY pane_id`,
      )
      .all(workspaceId) as {
      pane_id: string;
      session_id: string;
      cwd: string;
      last_command: string | null;
      command_json: string | null;
      agent_resume: string | null;
      agent: string | null;
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
      ...(r.agent ? { agent: r.agent } : {}),
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
