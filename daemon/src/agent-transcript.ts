/**
 * The last of a stored agent conversation, read from the file the agent CLI already keeps.
 *
 * For telling one resumable session from another. A single line of the first prompt is not enough
 * when three of them begin "help me with", and the alternative that suggests itself, starting the
 * agent to ask it, is not an alternative at all: resuming a session to find out whether you want
 * to resume it changes the thing you were inspecting, costs money, and takes seconds.
 *
 * So this reads the store and nothing else. No process is started. The files are the agent's, and
 * their shape is nobody's promise: every record this does not recognise is skipped, and a file it
 * cannot make sense of yields an empty transcript rather than an error.
 *
 * Read from the **end**, because that is the part that says what a session was about by the time
 * it stopped, and because these files reach megabytes.
 */
import { readFile, stat } from 'node:fs/promises';
import { debug } from './log.js';

export interface TranscriptTurn {
  role: 'you' | 'agent';
  text: string;
  /** When it happened, if the record says. Milliseconds. */
  at?: number;
}

/**
 * How much of the end of a file to read.
 *
 * Enough for a good many turns of ordinary conversation, small enough that opening one of these
 * is instant on a session that has been running all day. A turn holding a large tool result is
 * truncated by `MAX_CHARACTERS` rather than by this.
 */
const TAIL_BYTES = 256 * 1024;

/** No single turn is worth more than this on a card. Long tool output is not conversation. */
const MAX_CHARACTERS = 600;

/** Read the last bytes of a file, on a boundary that keeps whole lines. */
async function tailOf(path: string): Promise<string> {
  const info = await stat(path);
  const whole = await readFile(path, 'utf8');
  if (info.size <= TAIL_BYTES) return whole;
  const tail = whole.slice(-TAIL_BYTES);
  // The first line of a tail is almost certainly half a record. Dropping it costs one turn.
  return tail.slice(tail.indexOf('\n') + 1);
}

function clean(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CHARACTERS ? `${flat.slice(0, MAX_CHARACTERS)}…` : flat;
}

/** Text out of the content shape both stores use: a string, or a list of parts with `text`. */
function textFrom(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const text = (part as Record<string, unknown>)['text'];
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join(' ');
}

function timeFrom(record: Record<string, unknown>): number | undefined {
  const raw = record['timestamp'];
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return at;
  }
  return undefined;
}

/**
 * One turn out of a Claude Code record, or nothing.
 *
 * Tool calls, tool results, hook output and session metadata all live in the same file. None of
 * them is conversation, and a card full of them says less than an empty one.
 */
function claudeTurn(record: Record<string, unknown>): TranscriptTurn | null {
  const type = record['type'];
  if (type !== 'user' && type !== 'assistant') return null;
  const message = record['message'];
  if (typeof message !== 'object' || message === null) return null;
  const text = clean(textFrom((message as Record<string, unknown>)['content']));
  if (text === '') return null;
  const at = timeFrom(record);
  return { role: type === 'user' ? 'you' : 'agent', text, ...(at === undefined ? {} : { at }) };
}

/** The same for Codex, whose records wrap the message in a `payload`. */
function codexTurn(record: Record<string, unknown>): TranscriptTurn | null {
  const payload = record['payload'];
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as Record<string, unknown>;
  if (message['type'] !== 'message') return null;
  const role = message['role'];
  if (role !== 'user' && role !== 'assistant') return null;
  const text = clean(textFrom(message['content']));
  if (text === '') return null;
  const at = timeFrom(record) ?? timeFrom(message);
  return { role: role === 'user' ? 'you' : 'agent', text, ...(at === undefined ? {} : { at }) };
}

/**
 * The last turns of a stored conversation, oldest first.
 *
 * Oldest first within the window, because a conversation reads downwards even when only its end
 * is shown. Which end the window is taken from is the caller's business; it is always the last.
 */
export async function readTranscript(path: string, limit = 12): Promise<TranscriptTurn[]> {
  let text: string;
  try {
    text = await tailOf(path);
  } catch {
    debug('agent-transcript.unreadable', { path });
    return [];
  }

  const turns: TranscriptTurn[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A half-written line at the end of a file an agent is still using. Skip it.
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const turn = claudeTurn(record) ?? codexTurn(record);
    if (turn) turns.push(turn);
  }
  return turns.slice(-Math.max(1, limit));
}
