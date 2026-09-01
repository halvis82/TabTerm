import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from './log.js';

/**
 * Resumable Codex sessions, read from Codex's own store.
 *
 * A separate file from the Claude reader because they agree on nothing. Codex writes one
 * `rollout-*.jsonl` per session under `~/.codex/sessions/YYYY/MM/DD/`, and the first record is a
 * `session_meta` carrying both the id and the directory the session ran in. That is better than
 * the Claude store, which encodes the directory into a folder name lossily: here the directory
 * is stated, so nothing has to be guessed.
 *
 * They also resume differently, which is the defect this exists to fix. Codex takes a `resume`
 * **subcommand**, not a `--resume` flag, so every attempt was `codex --resume <id>`, which Codex
 * rejects. That is what "resume gives an error, at least for codex" was.
 *
 * As with the Claude reader: this is somebody else's undocumented format, so every failure is
 * "offer nothing" rather than an error.
 */

export interface CodexSession {
  sessionId: string;
  cwd: string;
  modifiedAt: number;
  summary?: string;
}

const DEFAULT_STORE = join(homedir(), '.codex', 'sessions');

/** Enough for the meta record and the first turn or two. These files reach megabytes. */
const HEAD_BYTES = 96 * 1024;

/**
 * Rollout files, newest first, without walking the whole tree.
 *
 * The store is nested by year, month and day, and the names sort chronologically at every level,
 * so descending the newest directories first reaches the newest sessions after reading a handful
 * of small directories rather than every day the store has ever held.
 */
async function newestFiles(store: string, want: number): Promise<{ path: string; at: number }[]> {
  const found: { path: string; at: number }[] = [];

  const descend = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= want) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    // Newest first at every level, which is what lets this stop early.
    names.sort((a, b) => b.localeCompare(a));
    for (const name of names) {
      if (found.length >= want) return;
      const full = join(dir, name);
      if (depth < 3) {
        await descend(full, depth + 1);
        continue;
      }
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      try {
        const info = await stat(full);
        if (info.isFile() && info.size > 0) found.push({ path: full, at: info.mtimeMs });
      } catch {
        /* vanished between listing and stat, which is normal for a live store */
      }
    }
  };

  await descend(store, 0);
  return found;
}

/**
 * What the meta record says: the id to resume, and the directory it belongs to.
 *
 * Both, or nothing. A rollout with no id cannot be resumed, and one with no directory would
 * have to be resumed somewhere guessed, which for an agent is a different conversation.
 */
function metaFrom(head: string): { sessionId: string; cwd: string } | null {
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record['type'] !== 'session_meta') continue;
    const payload = record['payload'];
    if (typeof payload !== 'object' || payload === null) return null;
    const meta = payload as Record<string, unknown>;
    const sessionId = meta['session_id'] ?? meta['id'];
    const cwd = meta['cwd'];
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (typeof cwd !== 'string' || cwd === '') return null;
    return { sessionId, cwd };
  }
  return null;
}

/**
 * A label, from the first thing the person actually typed.
 *
 * Skipped: the developer turn, which is instructions the harness injected, and anything that
 * opens with a tag, which is context rather than a request. Both are long and neither says
 * anything about what the session was for.
 */
function summaryFrom(head: string): string | null {
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = (parsed as Record<string, unknown>)['payload'];
    if (typeof payload !== 'object' || payload === null) continue;
    const message = payload as Record<string, unknown>;
    if (message['type'] !== 'message' || message['role'] !== 'user') continue;
    const content = message['content'];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const text = (part as Record<string, unknown>)['text'];
      if (typeof text !== 'string') continue;
      const trimmed = text.trim();
      if (trimmed === '' || trimmed.startsWith('<') || trimmed.startsWith('#')) continue;
      return trimmed.replace(/\s+/g, ' ').slice(0, 100);
    }
  }
  return null;
}

/** Codex sessions that could be resumed, newest first. Never throws. */
export async function listCodexResumable(options?: {
  cwd?: string;
  limit?: number;
  store?: string;
}): Promise<CodexSession[]> {
  const limit = options?.limit ?? 10;
  const store = options?.store ?? DEFAULT_STORE;
  // More than are wanted, because some will be filtered out: a rollout with no meta record, and
  // one whose directory has since been deleted.
  const files = await newestFiles(store, limit * 3);
  const out: CodexSession[] = [];

  for (const file of files) {
    if (out.length >= limit) break;
    let head: string;
    try {
      head = (await readFile(file.path, 'utf8')).slice(0, HEAD_BYTES);
    } catch {
      debug('codex-sessions.unreadable', { path: file.path });
      continue;
    }
    const meta = metaFrom(head);
    if (!meta) continue;
    if (options?.cwd && meta.cwd !== options.cwd) continue;

    const session: CodexSession = {
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      modifiedAt: file.at,
    };
    const summary = summaryFrom(head);
    if (summary) session.summary = summary;
    out.push(session);
  }

  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}
