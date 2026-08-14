import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import {
  findPlaceholders,
  type CommandEntry,
  type RecentDir,
  type SavedItem,
  type SavedKind,
} from '@tabterm/shared';

/** Anything the database holds that is not a known kind is treated as a command. */
function asKind(value: string): SavedKind {
  const kinds: readonly SavedKind[] = ['command', 'template', 'note', 'prompt', 'workflow'];
  return (kinds as readonly string[]).includes(value) ? (value as SavedKind) : 'command';
}
import type { Database } from './database.js';
import type { ProjectIndex } from './project-index.js';
import { buildWhere, parseHistoryQuery, scopeFilter, type Scope } from './history-query.js';

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

/** How far to widen when a text search comes up short. Bounded, and still an indexed read. */
const WIDEN_ROWS = 2000;

/** Directories nobody wants offered back to them. */
const BORING = new Set(['/', homedir(), '/tmp', '/private/tmp']);

/**
 * Directory trees nobody wants offered back to them.
 *
 * Temporary directories in particular: a build, a test run, or an installer works in one, and
 * every one of them is gone by the time you would click it. macOS puts per-user temp under
 * `/var/folders`, which is where they arrive from in practice and is not obviously temporary
 * from the path alone.
 */
const BORING_TREES = ['/var/folders/', '/private/var/folders/', '/tmp/', '/private/tmp/'];

function isBoring(path: string): boolean {
  if (BORING.has(path)) return true;
  return BORING_TREES.some((prefix) => path.startsWith(prefix));
}

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

/** How many recovery rows are worth keeping. Nothing looks further back than this. */
const MAX_SESSION_META = 500;

export class LauncherData {
  readonly #db: Database;
  #projects: ProjectIndex | null = null;
  /** What the last search actually applied, so the UI can show it rather than re-parse. */
  lastApplied: string[] = [];

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Attach project discovery.
   *
   * Optional, so tests and the launcher-only paths do not need one, and so nothing here ever
   * blocks on the filesystem if it is absent.
   */
  useProjectIndex(index: ProjectIndex): void {
    this.#projects = index;
  }

  /**
   * Resolve and store the repository a directory belongs to.
   *
   * Deliberately not awaited by its caller. Recording a directory happens on every prompt, and
   * that path must never wait on a stat. The row is updated when the answer arrives, and the
   * launcher reads whatever is known at the time it asks.
   */
  async #indexProject(path: string): Promise<void> {
    const index = this.#projects;
    if (!index) return;
    const found = await index.find(path);
    if (!found) return;

    this.#db.handle
      .prepare(
        `INSERT INTO projects (root, name, pinned, last_opened_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(root) DO UPDATE SET last_opened_at = excluded.last_opened_at`,
      )
      .run(found.root, found.name, Date.now());
    this.#db.handle
      .prepare('UPDATE recent_dirs SET git_root = ? WHERE path = ?')
      .run(found.root, path);
  }

  /** Repositories seen recently, most useful first. */
  projects(limit = 12): { root: string; name: string; pinned: boolean; lastOpenedAt: number }[] {
    const rows = this.#db.handle
      .prepare(
        `SELECT root, name, pinned, last_opened_at FROM projects
         ORDER BY pinned DESC, last_opened_at DESC LIMIT ?`,
      )
      .all(limit) as { root: string; name: string; pinned: number; last_opened_at: number }[];
    return rows.map((r) => ({
      root: r.root,
      name: r.name,
      pinned: r.pinned === 1,
      lastOpenedAt: r.last_opened_at,
    }));
  }

  // --- recent directories ------------------------------------------------

  /**
   * Record a visit. Frequency and recency both matter, so both are tracked: a directory you
   * enter constantly should not fall off just because you were somewhere else this morning.
   */
  recordDir(path: string): void {
    if (!path.startsWith('/') || isBoring(path)) return;
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

    // Fire and forget: the caller is on a per-prompt path and must not wait for a stat.
    void this.#indexProject(path).catch(() => {
      /* a directory that vanished, or an unreadable parent. Not worth reporting. */
    });
  }

  /**
   * Directories worth offering, most useful first.
   *
   * `requireExists` is on for everything a person sees and off for tests of the recording layer,
   * which deliberately use paths that are not on this disk. It is a seam rather than a setting:
   * offering a folder that is not there is never right in the product.
   */
  recentDirs(limit = 12, opts: { requireExists?: boolean } = {}): RecentDir[] {
    const requireExists = opts.requireExists !== false;
    const rows = this.#db.handle
      .prepare(
        `SELECT d.path, d.name, d.last_used_at, d.use_count, d.pinned, d.git_root, p.name AS project_name
         FROM recent_dirs d LEFT JOIN projects p ON p.root = d.git_root
         ORDER BY d.pinned DESC, d.last_used_at DESC LIMIT ?`,
      )
      .all(limit * 3) as {
      path: string;
      name: string;
      last_used_at: number;
      use_count: number;
      pinned: number;
      git_root: string | null;
      project_name: string | null;
    }[];

    /**
     * A folder that is no longer there is not a recent folder.
     *
     * Rows were written when a directory was used and never removed when it stopped existing, so
     * the list filled with temporary directories that had long since been deleted. Offering to
     * open one is offering something that cannot work, and it made the whole list read as
     * debris. Unpinned only: somebody who pinned a path meant it, even across a disk that is not
     * mounted right now.
     */
    const present = requireExists ? rows.filter((r) => r.pinned === 1 || existsSync(r.path)) : rows;
    if (requireExists && present.length !== rows.length) {
      const gone = rows.filter((r) => r.pinned !== 1 && !existsSync(r.path)).map((r) => r.path);
      try {
        const drop = this.#db.handle.prepare(
          'DELETE FROM recent_dirs WHERE path = ? AND pinned = 0',
        );
        for (const path of gone) drop.run(path);
      } catch {
        // Showing the right list matters more than succeeding at tidying the table.
      }
    }

    // Recency alone would drop a directory you live in after one busy day elsewhere, so the
    // final ranking applies a frequency bonus in code where it is easy to read and tune.
    return present
      .map((r) => ({
        path: r.path,
        name: r.name,
        lastUsedAt: r.last_used_at,
        useCount: r.use_count,
        pinned: r.pinned === 1,
        ...(r.git_root
          ? { project: { root: r.git_root, name: r.project_name ?? basename(r.git_root) } }
          : {}),
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
    /** Recorded so a search can be scoped to the terminal the user is looking at. */
    sessionId?: string;
  }): void {
    const command = entry.command.trim();
    if (command.length === 0 || command.length > 2000) return;
    // A leading space is the long-standing shell convention for "do not remember this".
    if (entry.command.startsWith(' ')) return;
    if (isSensitive(command)) return;

    const now = Date.now();
    // Only what the index already knows. This runs on every command, so it reads the cache and
    // never waits on a lookup; the directory was almost always recorded moments earlier.
    const root = this.#projects?.cached(entry.cwd)?.root ?? null;
    const existing = this.#db.handle
      .prepare('SELECT id FROM commands WHERE command = ? AND cwd = ?')
      .get(command, entry.cwd) as { id: string } | undefined;

    if (existing) {
      // Running the same thing again is a stronger signal than a new row would be.
      this.#db.handle
        .prepare(
          `UPDATE commands SET last_used_at = ?, use_count = use_count + 1,
             exit_code = COALESCE(?, exit_code), duration_ms = COALESCE(?, duration_ms),
             -- The most recent session to run it, so "this session" reflects where you are now.
             session_id = COALESCE(?, session_id),
             git_root = COALESCE(?, git_root)
           WHERE id = ?`,
        )
        .run(
          now,
          entry.exitCode ?? null,
          entry.durationMs ?? null,
          entry.sessionId ?? null,
          root,
          existing.id,
        );
      return;
    }

    this.#db.handle
      .prepare(
        `INSERT INTO commands (id, command, cwd, last_used_at, use_count, exit_code, duration_ms, git_root, session_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        command,
        entry.cwd,
        now,
        entry.exitCode ?? null,
        entry.durationMs ?? null,
        root,
        entry.sessionId ?? null,
      );

    this.#db.handle
      .prepare(
        `DELETE FROM commands WHERE id NOT IN (
           SELECT id FROM commands ORDER BY last_used_at DESC LIMIT ?
         )`,
      )
      .run(MAX_HISTORY);
  }

  /** Most recent first, optionally filtered. Deduplicated by command text. */
  /**
   * Search history.
   *
   * Filters run in SQL against indexed columns, and only the free-text part is matched in code.
   * That split is what keeps this fast on a large history: the database narrows to a page-sized
   * candidate set, and the fuzzy subsequence match, which no index can express, runs on that
   * rather than on the whole table. See docs/11-performance.md.
   *
   * Never loads the table wholesale. `offset` pages through results; a page that comes back
   * short of `limit` is the last one.
   */
  search(options: {
    query?: string;
    scope?: Scope;
    context?: { gitRoot?: string; cwd?: string; sessionId?: string };
    limit?: number;
    offset?: number;
    now?: number;
  }): CommandEntry[] {
    const limit = Math.min(200, Math.max(1, options.limit ?? 100));
    const offset = Math.max(0, options.offset ?? 0);
    const parsed = parseHistoryQuery(options.query ?? '', options.now ?? Date.now());

    const filters = [...parsed.filters];
    const scoped = scopeFilter(options.scope ?? 'global', options.context ?? {});
    if (scoped) filters.push(scoped);

    // A LIKE on the free text narrows in the database. It cannot express a subsequence match,
    // so it is a pre-filter only when the text is a plain substring of something.
    const text = parsed.text;
    const like = text ? `%${text.replaceAll('%', '').replaceAll('_', '')}%` : null;

    const where = buildWhere(filters);
    this.lastApplied = filters.map((f) => f.label);
    const rows = this.#queryCommands(where, like, limit, offset);
    const direct = text ? rows.filter((e) => matches(e.command, text)) : rows;
    if (!text || direct.length >= limit) return direct.slice(0, limit);

    // The LIKE narrowing misses subsequence matches, so widen once over the same filters. Still
    // bounded, and still indexed: this is a wider page, not a table scan.
    const seen = new Set(direct.map((e) => e.command));
    const out = [...direct];
    for (const r of this.#queryCommands(where, null, WIDEN_ROWS, offset)) {
      if (out.length >= limit) break;
      if (seen.has(r.command) || !matches(r.command, text)) continue;
      seen.add(r.command);
      out.push(r);
    }
    return out.slice(0, limit);
  }

  /** Kept for the existing palette call, which searches globally with no filters. */
  history(query = '', limit = 200): CommandEntry[] {
    return this.search({ query, limit });
  }

  #queryCommands(
    where: { sql: string; params: (string | number)[] },
    like: string | null,
    limit: number,
    offset: number,
  ): CommandEntry[] {
    const rows = this.#db.handle
      .prepare(
        `SELECT id, command, cwd, last_used_at, use_count, exit_code, duration_ms, git_root
         FROM commands
         WHERE ${where.sql} ${like === null ? '' : 'AND command LIKE ?'}
         ORDER BY last_used_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...where.params, ...(like === null ? [] : [like]), limit, offset) as {
      id: string;
      command: string;
      cwd: string;
      last_used_at: number;
      use_count: number;
      exit_code: number | null;
      duration_ms: number | null;
      git_root: string | null;
    }[];

    return rows.map((r) => ({
      id: r.id,
      command: r.command,
      cwd: r.cwd,
      lastUsedAt: r.last_used_at,
      useCount: r.use_count,
      ...(r.exit_code !== null ? { exitCode: r.exit_code } : {}),
      ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
      ...(r.git_root !== null ? { gitRoot: r.git_root } : {}),
    }));
  }

  clearHistory(): void {
    this.#db.handle.exec('DELETE FROM commands');
  }

  // --- saved items -------------------------------------------------------

  /**
   * Saved items, optionally narrowed to a project.
   *
   * Project-scoped items are returned alongside global ones rather than instead of them, so
   * being inside a repository adds to what is offered and never takes anything away.
   */
  saved(options?: { gitRoot?: string; kind?: SavedKind }): SavedItem[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options?.gitRoot) {
      clauses.push('(git_root IS NULL OR git_root = ?)');
      params.push(options.gitRoot);
    }
    if (options?.kind) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.#db.handle
      .prepare(
        `SELECT id, kind, title, body, tags, created_at, last_used_at, use_count, pinned, git_root, hotstring
         FROM saved_items ${where}
         ORDER BY pinned DESC, last_used_at DESC LIMIT 500`,
      )
      .all(...params) as {
      id: string;
      kind: string;
      title: string;
      body: string;
      tags: string;
      created_at: number;
      last_used_at: number;
      use_count: number;
      pinned: number;
      git_root: string | null;
      hotstring: string | null;
    }[];

    return rows.map((r) => {
      const placeholders = findPlaceholders(r.body).map((p) => p.name);
      return {
        id: r.id,
        kind: asKind(r.kind),
        title: r.title,
        body: r.body,
        tags: r.tags ? r.tags.split('\u0000') : [],
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        useCount: r.use_count,
        pinned: r.pinned === 1,
        ...(r.git_root !== null ? { gitRoot: r.git_root } : {}),
        ...(placeholders.length ? { placeholders } : {}),
        ...(r.hotstring ? { hotstring: r.hotstring } : {}),
      };
    });
  }

  save(item: {
    kind?: SavedKind;
    title: string;
    body: string;
    tags?: readonly string[];
    gitRoot?: string;
  }): SavedItem {
    const body = item.body.slice(0, 4000);
    const placeholders = findPlaceholders(body).map((p) => p.name);
    const entry: SavedItem = {
      id: randomUUID(),
      kind: item.kind ?? 'command',
      title: item.title.slice(0, 200),
      body,
      // Tags are stored NUL-joined in one column. A join table would be the textbook answer and
      // would buy nothing here: nobody has thousands of tags, and this keeps reads to one row.
      tags: (item.tags ?? []).slice(0, 12).map((t) => t.slice(0, 40)),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 0,
      pinned: false,
      ...(item.gitRoot ? { gitRoot: item.gitRoot } : {}),
      ...(placeholders.length ? { placeholders } : {}),
    };
    this.#db.handle
      .prepare(
        `INSERT INTO saved_items (id, kind, title, body, tags, created_at, last_used_at, use_count, pinned, git_root)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .run(
        entry.id,
        entry.kind,
        entry.title,
        entry.body,
        entry.tags.join('\u0000'),
        entry.createdAt,
        entry.lastUsedAt,
        entry.gitRoot ?? null,
      );
    return entry;
  }

  /**
   * Edit a favorite: its display name, its command, or its hotstring.
   *
   * A hotstring is refused rather than stolen if another favorite already claims it. Silently
   * moving a trigger between commands would mean an abbreviation someone relies on quietly
   * starts doing something else.
   */
  updateSaved(
    id: string,
    changes: { title?: string; body?: string; hotstring?: string | null },
  ): { ok: true } | { ok: false; reason: string } {
    const existing = this.#db.handle.prepare('SELECT id FROM saved_items WHERE id = ?').get(id) as
      { id: string } | undefined;
    if (!existing) return { ok: false, reason: 'no such item' };

    const hotstring = normalizeHotstring(changes.hotstring);
    if (hotstring.error) return { ok: false, reason: hotstring.error };

    if (hotstring.value) {
      const clash = this.#db.handle
        .prepare('SELECT id FROM saved_items WHERE hotstring = ? AND id != ?')
        .get(hotstring.value, id) as { id: string } | undefined;
      if (clash) return { ok: false, reason: `another favorite already uses ${hotstring.value}` };
    }

    this.#db.handle
      .prepare(
        `UPDATE saved_items SET
           title = COALESCE(?, title),
           body = COALESCE(?, body),
           hotstring = CASE WHEN ? THEN ? ELSE hotstring END
         WHERE id = ?`,
      )
      .run(
        changes.title?.slice(0, 200) ?? null,
        changes.body?.slice(0, 4000) ?? null,
        changes.hotstring === undefined ? 0 : 1,
        hotstring.value,
        id,
      );
    return { ok: true };
  }

  /** Every hotstring currently defined, for the frontend to match against. */
  hotstrings(): { trigger: string; command: string }[] {
    const rows = this.#db.handle
      .prepare('SELECT hotstring, body FROM saved_items WHERE hotstring IS NOT NULL')
      .all() as { hotstring: string; body: string }[];
    return rows.map((r) => ({ trigger: r.hotstring, command: r.body }));
  }

  deleteSaved(id: string): void {
    this.#db.handle.prepare('DELETE FROM saved_items WHERE id = ?').run(id);
  }

  /**
   * The most recent command run in a directory.
   *
   * Used to restart a server: the command that started it is the command that restarts it, and
   * history already knows what it was.
   */
  lastCommandIn(cwd: string): string | null {
    const row = this.#db.handle
      .prepare('SELECT command FROM commands WHERE cwd = ? ORDER BY last_used_at DESC LIMIT 1')
      .get(cwd) as { command: string } | undefined;
    return row?.command ?? null;
  }

  pinSaved(id: string, pinned: boolean): void {
    this.#db.handle
      .prepare('UPDATE saved_items SET pinned = ? WHERE id = ?')
      .run(pinned ? 1 : 0, id);
  }

  markUsed(id: string): void {
    this.#db.handle
      .prepare('UPDATE saved_items SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
      .run(Date.now(), id);
  }

  // --- session metadata, for recovery after expiry or a daemon restart ----

  #pruneSessionMeta(): void {
    try {
      this.#db.handle
        .prepare(
          `DELETE FROM session_meta WHERE id NOT IN (
             SELECT id FROM session_meta ORDER BY last_seen_at DESC LIMIT ?
           )`,
        )
        .run(MAX_SESSION_META);
    } catch {
      // A prune that fails costs disk, not correctness.
    }
  }

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

    /**
     * Keep this table bounded.
     *
     * These rows exist so an expired tab can say where it was and what it last ran. They are
     * written on every prompt and never removed, so a machine that has been up for months
     * accumulates a row per session forever. Recovery only ever looks at recent ones.
     */
    this.#pruneSessionMeta();
  }

  /**
   * What a tab can show when its session is gone.
   *
   * The process cannot come back, but where it was and what it last ran can, which is the
   * difference between a useful recovery screen and an apology. See docs/04-session-lifecycle.md §8.
   */
  recallWorkspace(
    workspaceId: string,
  ): { cwd: string; lastCommand?: string; lastSeenAt: number; sessionId: string } | null {
    const row = this.#db.handle
      .prepare(
        `SELECT id, cwd, last_command, last_seen_at FROM session_meta
         WHERE workspace_id = ? ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .get(workspaceId) as
      { id: string; cwd: string; last_command: string | null; last_seen_at: number } | undefined;
    if (!row) return null;
    return {
      // Carried so the caller can find this session's history on disk, which is the only thing
      // a tab whose processes are gone still has to show.
      sessionId: row.id,
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

/**
 * Validate a hotstring.
 *
 * Whitespace is refused because a space is what *ends* an abbreviation: a trigger containing one
 * could never be completed. An empty value clears it rather than being an error, since that is
 * how a hotstring is removed.
 */
function normalizeHotstring(raw: string | null | undefined): {
  value: string | null;
  error?: string;
} {
  if (raw === undefined) return { value: null };
  if (raw === null) return { value: null };
  const trimmed = raw.trim();
  if (!trimmed) return { value: null };
  if (/\s/.test(trimmed)) {
    return { value: null, error: 'a hotstring cannot contain spaces' };
  }
  if (trimmed.length > 64)
    return { value: null, error: 'a hotstring that long is not an abbreviation' };
  return { value: trimmed };
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
