import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { paths } from './config.js';
import { info, warn } from './log.js';

/**
 * Durable storage.
 *
 * SQLite via Node's built-in module, so there is no native dependency to compile or stage.
 * See ADR-0015 for why not better-sqlite3.
 *
 * The database is never mirrored into JS memory. Everything goes through prepared statements
 * with indices behind them, so a large history stays a query rather than a scan.
 * See docs/03-data-model.md.
 */

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE recent_dirs (
        path         TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 1,
        pinned       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_dirs_rank ON recent_dirs(pinned DESC, last_used_at DESC);

      CREATE TABLE commands (
        id           TEXT PRIMARY KEY,
        command      TEXT NOT NULL,
        cwd          TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 1,
        exit_code    INTEGER,
        duration_ms  INTEGER
      );
      CREATE INDEX idx_cmd_recent ON commands(last_used_at DESC);
      CREATE INDEX idx_cmd_text   ON commands(command);
      CREATE INDEX idx_cmd_cwd    ON commands(cwd, last_used_at DESC);

      CREATE TABLE saved_items (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        tags         TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_saved_recent ON saved_items(last_used_at DESC);

      -- Enough to offer a meaningful recovery after the daemon restarts. The processes
      -- themselves cannot survive, but where you were and what you ran can.
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY,
        layout_json TEXT NOT NULL,
        pinned      INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE session_meta (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT,
        cwd           TEXT NOT NULL,
        shell         TEXT NOT NULL,
        command_json  TEXT,
        last_seen_at  INTEGER NOT NULL,
        last_command  TEXT
      );
      CREATE INDEX idx_meta_ws ON session_meta(workspace_id);
    `,
  },
];

export class Database {
  readonly #db: DatabaseSync;

  constructor(file?: string) {
    const target = file ?? paths.database;
    if (target !== ':memory:') mkdirSync(paths.state, { recursive: true, mode: 0o700 });

    this.#db = new DatabaseSync(target);
    // WAL keeps a reader from blocking the writer, which matters because the daemon writes on
    // every prompt while the launcher reads on every new tab.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  get handle(): DatabaseSync {
    return this.#db;
  }

  /**
   * Forward-only migrations.
   *
   * A failed migration leaves the previous schema intact and throws, rather than continuing
   * against a half-migrated database. See docs/03-data-model.md §4.
   */
  #migrate(): void {
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const applied = new Set(
      (this.#db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map(
        (r) => r.version,
      ),
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      try {
        this.#db.exec('BEGIN');
        this.#db.exec(migration.sql);
        this.#db
          .prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, Date.now());
        this.#db.exec('COMMIT');
        info('db.migrated', { version: migration.version });
      } catch (e) {
        this.#db.exec('ROLLBACK');
        warn('db.migration.failed', { version: migration.version, error: String(e) });
        throw e;
      }
    }
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      /* already closed */
    }
  }
}
