import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { CommandEntry, RecentDir, SavedItem } from '@tabterm/shared';
import { JsonStore } from './store.js';

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
  readonly #dirs = new JsonStore<RecentDir[]>('recent-dirs', []);
  readonly #history = new JsonStore<CommandEntry[]>('command-history', []);
  readonly #saved = new JsonStore<SavedItem[]>('saved-items', []);

  // --- recent directories ------------------------------------------------

  /**
   * Record a visit. Frequency and recency both matter, so both are tracked: a directory you
   * enter constantly should not fall off just because you were somewhere else this morning.
   */
  recordDir(path: string): void {
    if (!path.startsWith('/') || BORING.has(path)) return;
    this.#dirs.update((list) => {
      const existing = list.find((d) => d.path === path);
      if (existing) {
        existing.lastUsedAt = Date.now();
        existing.useCount++;
      } else {
        list.push({
          path,
          name: basename(path) || path,
          lastUsedAt: Date.now(),
          useCount: 1,
          pinned: false,
        });
      }
      list.sort((a, b) => score(b) - score(a));
      return list.slice(0, MAX_RECENT_DIRS);
    });
  }

  recentDirs(limit = 12): RecentDir[] {
    return this.#dirs
      .read()
      .slice()
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit);
  }

  pinDir(path: string, pinned: boolean): void {
    this.#dirs.update((list) => {
      const hit = list.find((d) => d.path === path);
      if (hit) hit.pinned = pinned;
      return list;
    });
  }

  forgetDir(path: string): void {
    this.#dirs.update((list) => list.filter((d) => d.path !== path));
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

    this.#history.update((list) => {
      // Collapse an immediate repeat rather than filling history with the same line.
      const last = list[list.length - 1];
      if (last && last.command === command && last.cwd === entry.cwd) {
        last.lastUsedAt = Date.now();
        last.useCount++;
        if (entry.exitCode !== undefined) last.exitCode = entry.exitCode;
        return list;
      }
      list.push({
        id: randomUUID(),
        command,
        cwd: entry.cwd,
        lastUsedAt: Date.now(),
        useCount: 1,
        ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      });
      return list.length > MAX_HISTORY ? list.slice(-MAX_HISTORY) : list;
    });
  }

  /** Most recent first, optionally filtered. Deduplicated by command text. */
  history(query = '', limit = 200): CommandEntry[] {
    const all = this.#history.read();
    const seen = new Set<string>();
    const out: CommandEntry[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = all[i] as CommandEntry;
      if (seen.has(entry.command)) continue;
      if (query && !matches(entry.command, query)) continue;
      seen.add(entry.command);
      out.push(entry);
    }
    return out;
  }

  clearHistory(): void {
    this.#history.update(() => []);
  }

  // --- saved items -------------------------------------------------------

  saved(): SavedItem[] {
    return this.#saved
      .read()
      .slice()
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
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
    this.#saved.update((list) => [entry, ...list].slice(0, 500));
    return entry;
  }

  deleteSaved(id: string): void {
    this.#saved.update((list) => list.filter((i) => i.id !== id));
  }

  markUsed(id: string): void {
    this.#saved.update((list) => {
      const hit = list.find((i) => i.id === id);
      if (hit) {
        hit.lastUsedAt = Date.now();
        hit.useCount++;
      }
      return list;
    });
  }

  flush(): void {
    this.#dirs.flush();
    this.#history.flush();
    this.#saved.flush();
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
