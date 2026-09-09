import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readHead, readTail } from './file-slice.js';
import { debug } from './log.js';

/**
 * Resumable agent sessions, read from the agent CLI's own store.
 *
 * This is somebody else's file format, on disk, undocumented and free to change. Every
 * assumption here is therefore checked and every failure is "offer nothing" rather than an
 * error: a store that has moved or changed shape must degrade to a launcher with no resume
 * chips, never to a broken launcher. See docs/09-agent-integration.md.
 *
 * Nothing here ever resumes anything. It reports what could be resumed; a person decides.
 */

export interface ResumableSession {
  /** The id to pass to the agent CLI. */
  sessionId: string;
  /** Directory the session belongs to. */
  cwd: string;
  modifiedAt: number;
  /** First words of the last prompt, when they can be read. Purely a label. */
  summary?: string;
  /**
   * The file this was read from.
   *
   * Carried rather than reconstructed. The store's directory naming is lossy, so encoding a path
   * again can name a directory that belongs to a different project, and a transcript shown
   * against the wrong session is worse than none.
   */
  path?: string;
}

const DEFAULT_STORE = join(homedir(), '.claude', 'projects');

/**
 * How much of a session file to read looking for a label.
 *
 * The first real message can sit well past the start, behind session metadata and hook output,
 * so 8 KB was not enough in practice. These files reach megabytes, so this stays a bounded head
 * read rather than becoming a scan.
 */
const HEAD_BYTES = 128 * 1024;

/**
 * How much of the end of a file to read to learn what a row needs.
 *
 * The end, for both of the things read there. The title record is rewritten as a session goes on,
 * so only the last one describes what the session became; in a 97 MB transcript it sat 21 KB from
 * the end. The entrypoint is repeated on every turn, so the end carries it as well as the start.
 *
 * Reading it from the start was tried and does not work. The field sits inside the first
 * conversation record, and in the machine-made sessions this exists to exclude that record runs to
 * a median of 159 KB and a maximum of 623 KB, so a bounded head read returns a truncated line that
 * will not parse, finds no entrypoint, and keeps every session it was meant to reject. From the
 * end, one 64 KB read classified 151 of 161 real files; the ten it cannot are files with no
 * entrypoint anywhere, which are kept regardless.
 */
const TAIL_BYTES = 64 * 1024;

/**
 * Entrypoints that are not a person at a terminal.
 *
 * Claude Code records how it was started, and sessions driven through its SDK are written to the
 * same store as sessions somebody typed. They are not work anyone would resume: they are a
 * program's own conversations, they are generated continuously, and they are numerous enough to
 * bury everything else. On this machine 123 of 161 stored sessions were `sdk-ts`, all of them
 * belonging to one plugin.
 *
 * Matched on the prefix, so a future `sdk-py` is covered without another release. Anything else,
 * including an entrypoint this does not recognise and a file too old to carry the field at all, is
 * kept: a session hidden from the list is worse than one shown, and only this one thing is known
 * to be machine-made.
 */
function startedByAProgram(entrypoint: string | null): boolean {
  return entrypoint !== null && entrypoint.startsWith('sdk');
}

/**
 * How far down the sorted candidates to look before giving up on filling the list.
 *
 * Generous on purpose. Machine-made sessions are written continuously, so they are all newer than
 * the real work and sit ahead of it: a tight bound here does not save time, it just returns a
 * short list. The walk stops the moment the list is full, so this ceiling is only reached by a
 * store that really is mostly machine-made, and it costs one 8 KB read per file to establish that.
 */
const MAX_INSPECTED = 500;

/**
 * The store's directory naming: a path with every separator replaced by a hyphen.
 *
 * The encoding is **lossy and not reversible**. A real hyphen looks like a separator, and so
 * does an underscore, so `/a/b_c` and `/a/b/c` and `/a/b-c` all become `-a-b-c`. Guessing
 * would silently attach a resume to the wrong project.
 *
 * The way around it is to go the other direction: encode directories that are already known to
 * exist and look for their name in the store. That is exact, and the daemon has a list of
 * directories from `recent_dirs` and `projects` for free.
 */
export function encodeStoreDir(cwd: string): string {
  return cwd.replaceAll('/', '-').replaceAll('_', '-').replaceAll('.', '-');
}

/**
 * Best-effort reverse, used only for store directories no known path accounts for.
 *
 * Every candidate it produces is confirmed against the filesystem before being used, and an
 * unresolvable one is skipped rather than guessed at.
 */
export function decodeStoreDir(name: string): string[] {
  if (!name.startsWith('-')) return [];
  const parts = name.slice(1).split('-');
  const candidates: string[] = [];

  // Treating every hyphen as a separator, then progressively fewer. The full space is
  // exponential, so this covers the realistic cases and stops.
  for (let joinFrom = parts.length; joinFrom >= 1; joinFrom--) {
    const head = parts.slice(0, joinFrom);
    const tail = parts.slice(joinFrom);
    const path = `/${head.join('/')}${tail.length ? `-${tail.join('-')}` : ''}`;
    candidates.push(path);
    if (candidates.length >= 12) break;
  }
  return candidates;
}

/** Sessions that could be resumed, newest first. Never throws. */
export async function listResumable(options?: {
  cwd?: string;
  /** Directories the daemon already knows about, which makes the mapping exact. */
  knownDirs?: readonly string[];
  limit?: number;
  /** Where the store is, so a test can point at a fixture instead of a real home directory. */
  store?: string;
}): Promise<ResumableSession[]> {
  const limit = options?.limit ?? 10;
  const STORE = options?.store ?? DEFAULT_STORE;
  const byEncoded = new Map<string, string>();
  for (const dir of options?.knownDirs ?? []) byEncoded.set(encodeStoreDir(dir), dir);
  if (options?.cwd) byEncoded.set(encodeStoreDir(options.cwd), options.cwd);
  let dirs: string[];
  try {
    dirs = await readdir(STORE);
  } catch {
    // No store, or no permission. Both mean the same thing to a user: nothing to offer.
    return [];
  }

  const found: { session: ResumableSession; storeDir: string }[] = [];
  for (const dir of dirs) {
    const cwd = byEncoded.get(dir) ?? (await resolveStoreDir(dir));
    if (!cwd) continue;
    if (options?.cwd && cwd !== options.cwd) continue;

    let files: string[];
    try {
      files = (await readdir(join(STORE, dir))).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const full = join(STORE, dir, file);
      try {
        const info = await stat(full);
        if (!info.isFile() || info.size === 0) continue;
        found.push({
          session: {
            sessionId: basename(file, '.jsonl'),
            cwd,
            modifiedAt: info.mtimeMs,
            path: full,
          },
          storeDir: dir,
        });
      } catch {
        /* vanished between listing and stat, which is normal for a live store */
      }
    }
  }

  found.sort((a, b) => b.session.modifiedAt - a.session.modifiedAt);

  /**
   * Filled by walking the sorted list, rather than by taking the first `limit` and filtering it.
   *
   * Filtering after the slice would not work here. The machine-made sessions are the newest ones,
   * being written continuously, so they take every slot and are then dropped, and the list comes
   * back nearly empty of anything real.
   *
   * The walk stops as soon as the list is full, so an ordinary store costs `limit` small reads.
   * `MAX_INSPECTED` bounds the other end, where a store holds thousands of machine-made sessions
   * and little else: that yields a short list rather than an unbounded scan.
   */
  const top: { session: ResumableSession; storeDir: string; title: string | null }[] = [];
  for (const candidate of found.slice(0, MAX_INSPECTED)) {
    if (top.length >= limit) break;
    const facts = await readTailFacts(candidate.session.path ?? '');
    if (startedByAProgram(facts.entrypoint)) continue;
    top.push({ ...candidate, title: facts.title });
  }

  // Only the ones actually being offered get read, so a large store costs a stat per file and
  // a read per visible chip. The store directory is carried along rather than recomputed,
  // because the encoding cannot be trusted to round-trip.
  /**
   * Read the ones being offered, and drop anything that is not a conversation.
   *
   * Not every `.jsonl` beside a conversation is one. A summary sidecar carries only `summary`
   * records, has no `sessionId` anywhere in it, and the agent CLI refuses to resume it: picking
   * one produced "No conversation found with session ID" and an immediate exit, which read as
   * resume being broken rather than as that row not being a session.
   *
   * The id used is the one recorded inside the file rather than its name, so a store that ever
   * renames a file cannot make every row resume the wrong thing.
   */
  const described = await Promise.all(
    top.map(async ({ session, storeDir, title }) => {
      const path = join(STORE, storeDir, `${session.sessionId}.jsonl`);
      const [summary, recordedId] = await Promise.all([readSummary(path), readSessionId(path)]);
      if (recordedId === null) return null;
      // The agent's own title first: a few words describing the session as a whole, kept current
      // as the work moves on, which is what somebody scanning a list needs. The first thing typed
      // is the fallback, and a weak one. It is often a pasted path, or a request whose subject
      // only became clear later.
      const label = title ?? summary;
      if (label) session.summary = label;
      session.sessionId = recordedId;
      return session;
    }),
  );
  return described.filter((s): s is ResumableSession => s !== null);
}

/** A store directory maps to a real path only once that path is confirmed to exist. */
async function resolveStoreDir(name: string): Promise<string | null> {
  for (const candidate of decodeStoreDir(name)) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * A short label for a session.
 *
 * Reads only the head of the file. These grow to megabytes, and a launcher chip needs a few
 * words, so reading the whole thing to find them would be the wrong trade.
 */
/**
 * The conversation id the store itself records, or null when there is not one.
 *
 * Null is the answer for a file that is not a conversation, and is what keeps unresumable rows
 * out of the list rather than leaving them to fail when somebody picks one.
 */
async function readSessionId(path: string): Promise<string | null> {
  try {
    const head = await readHead(path, HEAD_BYTES);
    for (const line of head.split('\n')) {
      if (!line.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const id = (parsed as Record<string, unknown>)['sessionId'];
      if (typeof id === 'string' && id !== '') return id;
    }
  } catch {
    debug('agent-sessions.id.unreadable', { path });
  }
  return null;
}

/** What one read of the end of a file can say about a session. */
interface TailFacts {
  /** How the session was started, when the store says. */
  entrypoint: string | null;
  /** The title the agent kept for it, when there is one. */
  title: string | null;
}

/**
 * Both facts a row needs, from a single read of the end of the file.
 *
 * One read rather than two because they come from the same place and are wanted at the same time.
 * It runs against every candidate, including the many about to be rejected, which is what keeps
 * the walk affordable.
 *
 * A partial line at the head of a tail read is expected, and is skipped like any other line that
 * will not parse.
 */
async function readTailFacts(path: string): Promise<TailFacts> {
  if (path === '') return { entrypoint: null, title: null };
  let entrypoint: string | null = null;
  let title: string | null = null;
  try {
    const tail = await readTail(path, TAIL_BYTES);
    for (const line of tail.split('\n')) {
      if (!line.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const entry = record['entrypoint'];
      if (typeof entry === 'string' && entry !== '') entrypoint = entry;
      if (record['type'] === 'ai-title') {
        const found = record['aiTitle'];
        // The last one wins: earlier titles describe a session the work has since moved past.
        if (typeof found === 'string' && found.trim() !== '') title = found.trim();
      }
    }
  } catch {
    debug('agent-sessions.tail.unreadable', { path });
  }
  return {
    entrypoint,
    title: title === null ? null : title.replace(/\s+/g, ' ').slice(0, 100),
  };
}

async function readSummary(path: string): Promise<string | null> {
  try {
    const head = await readHead(path, HEAD_BYTES);
    for (const line of head.split('\n')) {
      if (!line.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const text = summaryFrom(parsed);
      if (text) return text.replace(/\s+/g, ' ').trim().slice(0, 100);
    }
  } catch {
    debug('agent-sessions.summary.unreadable', { path });
  }
  return null;
}

/**
 * Pull a human-readable line out of one store record.
 *
 * Written against a format nobody promised to keep. Every shape it does not recognize returns
 * null, which costs a label and nothing else.
 */
function summaryFrom(record: unknown): string | null {
  if (typeof record !== 'object' || record === null) return null;
  const obj = record as Record<string, unknown>;

  if (typeof obj['summary'] === 'string') return obj['summary'];
  // Only what a person typed. Assistant turns, tool results and hook output all appear in the
  // same file and none of them make a useful label.
  if (obj['type'] !== 'user') return null;

  const message = obj['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];

  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>)['text'];
        if (typeof text === 'string') texts.push(text);
      }
    }
  }

  for (const text of texts) {
    const trimmed = text.trim();
    // Injected context arrives as a user turn wrapped in a tag. It is not what anyone asked.
    if (!trimmed || trimmed.startsWith('<')) continue;
    return trimmed;
  }
  return null;
}
