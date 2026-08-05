import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { CommandEntry, RecentDir, SavedItem } from '@tabterm/shared';
import type { Database } from './database.js';

/**
 * What the launcher shows: where you have been, what you have run, and what you have kept.
 *
 * All of it is local and never leaves the machine. History in particular is treated as
 * sensitive by default: leading-space commands are dropped, and anything matching a secret
 * pattern is discarded rather than stored redacted, because a redacted secret is still a
 * record that one existed. See docs/05-security.md §7.
 */

const MAX_RECENT_DIRS = 60;
const MAX_HISTORY = 5000;

/** Directories nobody wants offered back to them. */
const BORING = new Set(['/', homedir(), '/tmp', '/private/tmp']);

/**
 * Commands that must never be written down.
 *
 * Dropped entirely rather than stored with the value blanked: the existence of the command is
 * itself a disclosure, and a launcher that shows `export AWS_SECRET=***` is an invitation to
 * go looking for the real one.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|\s)export\s+\w*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL)\w*=/i,
  /--?(api[-_]?key|token|password|secret)\b/i,
  /\bAuthorization:\s*Bearer\b/i,
  /\b(password|passwd|secret|token)=\S/i,
  /\bcurl\b[^|]*(^|\s)-u\s+\S+:\S+/i,
  /\b(ssh-add|security\s+add-generic-password)\b/i,
];

export function isSensitive(command: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(command));
}

export class LauncherData {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  // --- recent directories ------------------------------------------------

  /**
   * Record a visit. Frequency and recency both matter, so both are tracked: a directory you
   * enter constantly should not fall off just because you were somewhere else this morning.
   */
  recordDir(path: string): void {
    if (!path.startsWith('/') || BORING.has(path)) return;
    this.#db.handle
      .prepare(
        `INSERT INTO recent_dirs (path, name, last_used_at, use_count, pinned)
         VALUES (?, ?, ?, 1, 0)
         ON CONFLICT(path) DO UPDATE SET
           last_used_at = excluded.last_used_at,
           use_count = use_count + 1`,
      )
      .run(path, basename(path) || path, Date.now());

    // Keep the table bounded. Pinned rows are never candidates for eviction.
    this.#db.handle
      .prepare(
        `DELETE FROM recent_dirs WHERE pinned = 0 AND path NOT IN (
           SELECT path FROM recent_dirs ORDER BY pinned DESC, last_used_at DESC LIMIT ?
         )`,
      )
      .run(MAX_RECENT_DIRS);
  }

  recentDirs(limit = 12): RecentDir[] {
    const rows = this.#db.handle
      .prepare(
        `SELECT path, name, last_used_at, use_count, pinned
         FROM recent_dirs ORDER BY pinned DESC, last_used_at DESC LIMIT ?`,
      )
      .all(limit * 3) as {
      path: string;
      name: string;
      last_used_at: number;
      use_count: number;
      pinned: number;
    }[];

    // Recency alone would drop a directory you live in after one busy day elsewhere, so the
    // final ranking applies a frequency bonus in code where it is easy to read and tune.
    return rows
      .map((r) => ({
        path: r.path,
        name: r.name,
        lastUsedAt: r.last_used_at,
        useCount: r.use_count,
        pinned: r.pinned === 1,
      }))
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit);
  }

  pinDir(path: string, pinned: boolean): void {
    this.#db.handle
      .prepare('UPDATE recent_dirs SET pinned = ? WHERE path = ?')
      .run(pinned ? 1 : 0, path);
  }

  forgetDir(path: string): void {
    this.#db.handle.prepare('DELETE FROM recent_dirs WHERE path = ?').run(path);
  }

  // --- command history ---------------------------------------------------

  recordCommand(entry: {
    command: string;
    cwd: string;
    exitCode?: number;
    durationMs?: number;
  }): void {
    const command = entry.command.trim();
    if (command.length === 0 || command.length > 2000) return;
    // A leading space is the long-standing shell convention for "do not remember this".
    if (entry.command.startsWith(' ')) return;
    if (isSensitive(command)) return;

    const now = Date.now();
    const existing = this.#db.handle
      .prepare('SELECT id FROM commands WHERE command = ? AND cwd = ?')
      .get(command, entry.cwd) as { id: string } | undefined;

    if (existing) {
      // Running the same thing again is a stronger signal than a new row would be.
      this.#db.handle
        .prepare(
          `UPDATE commands SET last_used_at = ?, use_count = use_count + 1,
             exit_code = COALESCE(?, exit_code), duration_ms = COALESCE(?, duration_ms)
           WHERE id = ?`,
        )
        .run(now, entry.exitCode ?? null, entry.durationMs ?? null, existing.id);
      return;
    }

    this.#db.handle
      .prepare(
        `INSERT INTO commands (id, command, cwd, last_used_at, use_count, exit_code, duration_ms)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(randomUUID(), command, entry.cwd, now, entry.exitCode ?? null, entry.durationMs ?? null);

    this.#db.handle
      .prepare(
        `DELETE FROM commands WHERE id NOT IN (
           SELECT id FROM commands ORDER BY last_used_at DESC LIMIT ?
         )`,
      )
      .run(MAX_HISTORY);
  }

  /** Most recent first, optionally filtered. Deduplicated by command text. */
  history(query = '', limit = 200): CommandEntry[] {
    // Narrow in SQL with an indexed LIKE first, then apply the fuzzy match in code. Doing the
    // whole thing in code would mean reading every row; doing it all in SQL would lose
    // subsequence matching, which is what makes `gco` find `git checkout`.
    const like = query ? `%${query.replaceAll('%', '').replaceAll('_', '')}%` : '%';
    const rows = this.#db.handle
      .prepare(
        `SELECT id, command, cwd, last_used_at, use_count, exit_code, duration_ms
         FROM commands
         WHERE (? = '%' OR command LIKE ?)
         ORDER BY last_used_at DESC
         LIMIT ?`,
      )
      .all(like, like, Math.max(limit * 4, 400)) as {
      id: string;
      command: string;
      cwd: string;
      last_used_at: number;
      use_count: number;
      exit_code: number | null;
      duration_ms: number | null;
    }[];

    const mapped = rows.map((r) => ({
      id: r.id,
      command: r.command,
      cwd: r.cwd,
      lastUsedAt: r.last_used_at,
      useCount: r.use_count,
      ...(r.exit_code !== null ? { exitCode: r.exit_code } : {}),
      ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
    }));

    const direct = mapped.filter((e) => matches(e.command, query));
    if (direct.length >= limit || !query) return direct.slice(0, limit);

    // The LIKE narrowing misses subsequence matches, so widen once if it came up short.
    const wide = this.#db.handle
      .prepare(
        `SELECT id, command, cwd, last_used_at, use_count, exit_code, duration_ms
         FROM commands ORDER BY last_used_at DESC LIMIT 2000`,
      )
      .all() as typeof rows;

    const seen = new Set(direct.map((e) => e.command));
    for (const r of wide) {
      if (direct.length >= limit) break;
      if (seen.has(r.command) || !matches(r.command, query)) continue;
      seen.add(r.command);
      direct.push({
        id: r.id,
        command: r.command,
        cwd: r.cwd,
        lastUsedAt: r.last_used_at,
        useCount: r.use_count,
        ...(r.exit_code !== null ? { exitCode: r.exit_code } : {}),
        ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
      });
    }
    return direct.slice(0, limit);
  }

  clearHistory(): void {
    this.#db.handle.exec('DELETE FROM commands');
  }

  // --- saved items -------------------------------------------------------

  saved(): SavedItem[] {
    const rows = this.#db.handle
      .prepare(
        `SELECT id, title, body, tags, created_at, last_used_at, use_count
         FROM saved_items ORDER BY last_used_at DESC LIMIT 500`,
      )
      .all() as {
      id: string;
      title: string;
      body: string;
      tags: string;
      created_at: number;
      last_used_at: number;
      use_count: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      tags: r.tags ? r.tags.split('\u0000') : [],
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      useCount: r.use_count,
    }));
  }

  save(item: { title: string; body: string; tags?: readonly string[] }): SavedItem {
    const entry: SavedItem = {
      id: randomUUID(),
      title: item.title.slice(0, 200),
      body: item.body.slice(0, 4000),
      tags: (item.tags ?? []).slice(0, 12),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 0,
    };
    this.#db.handle
      .prepare(
        `INSERT INTO saved_items (id, title, body, tags, created_at, last_used_at, use_count)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        entry.id,
        entry.title,
        entry.body,
        entry.tags.join('\u0000'),
        entry.createdAt,
        entry.lastUsedAt,
      );
    return entry;
  }

  deleteSaved(id: string): void {
    this.#db.handle.prepare('DELETE FROM saved_items WHERE id = ?').run(id);
  }

  markUsed(id: string): void {
    this.#db.handle
      .prepare('UPDATE saved_items SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
      .run(Date.now(), id);
  }

  // --- session metadata, for recovery after expiry or a daemon restart ----

  rememberSession(meta: {
    id: string;
    workspaceId?: string;
    cwd: string;
    shell: string;
    command?: readonly string[];
    lastCommand?: string;
  }): void {
    this.#db.handle
      .prepare(
        `INSERT INTO session_meta (id, workspace_id, cwd, shell, command_json, last_seen_at, last_command)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           cwd = excluded.cwd,
           last_seen_at = excluded.last_seen_at,
           last_command = COALESCE(excluded.last_command, last_command)`,
      )
      .run(
        meta.id,
        meta.workspaceId ?? null,
        meta.cwd,
        meta.shell,
        meta.command ? JSON.stringify(meta.command) : null,
        Date.now(),
        meta.lastCommand ?? null,
      );
  }

  /**
   * What a tab can show when its session is gone.
   *
   * The process cannot come back, but where it was and what it last ran can, which is the
   * difference between a useful recovery screen and an apology. See docs/04-session-lifecycle.md §8.
   */
  recallWorkspace(
    workspaceId: string,
  ): { cwd: string; lastCommand?: string; lastSeenAt: number } | null {
    const row = this.#db.handle
      .prepare(
        `SELECT cwd, last_command, last_seen_at FROM session_meta
         WHERE workspace_id = ? ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .get(workspaceId) as
      { cwd: string; last_command: string | null; last_seen_at: number } | undefined;
    if (!row) return null;
    return {
      cwd: row.cwd,
      lastSeenAt: row.last_seen_at,
      ...(row.last_command ? { lastCommand: row.last_command } : {}),
    };
  }

  /** Keep the metadata table from growing without bound. */
  pruneSessions(olderThanMs: number): void {
    this.#db.handle
      .prepare('DELETE FROM session_meta WHERE last_seen_at < ?')
      .run(Date.now() - olderThanMs);
  }

  /** Retained so shutdown stays symmetric. SQLite durability is handled by WAL. */
  flush(): void {
    /* nothing to flush */
  }
}

/** Recency with a frequency bonus, so a favorite directory does not fall off after one busy day. */
function score(d: RecentDir): number {
  const base = d.lastUsedAt + Math.min(d.useCount, 40) * 60_000;
  return d.pinned ? base + 1e13 : base;
}

/** Subsequence match, so `gco` finds `git checkout`. */
export function matches(haystack: string, query: string): boolean {
  const h = haystack.toLowerCase();
  const q = query.toLowerCase().trim();
  if (q.length === 0) return true;
  if (h.includes(q)) return true;
  let i = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}
