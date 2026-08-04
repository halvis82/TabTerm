/**
 * OSC 7 and OSC 133 parsing.
 *
 * The daemon sees bytes, not meaning. These two standards supply the meaning: where you are,
 * when a command started, and how it ended. See docs/08-shell-integration.md.
 *
 * Terminal output is untrusted. Every value here is length-capped and validated before it
 * reaches a display field, and none of it ever reaches a spawn path. See docs/05-security.md.
 */
export interface OscEvents {
  onCwd: (cwd: string) => void;
  onPromptStart: () => void;
  onCommandStart: () => void;
  onCommandEnd: (exitCode: number) => void;
}

const MAX_OSC_PAYLOAD = 4096;
const ESC = 0x1b;
const BEL = 0x07;

/**
 * A streaming scanner. PTY output arrives in arbitrary chunks, so a sequence can be split
 * across reads and the scanner has to carry a partial across calls.
 */
export class OscScanner {
  #pending = '';
  readonly #events: OscEvents;

  constructor(events: OscEvents) {
    this.#events = events;
  }

  feed(chunk: string): void {
    this.#pending += chunk;

    for (;;) {
      const start = findIntroducer(this.#pending);
      if (start === -1) {
        // Keep only a possible split introducer, never the whole stream.
        this.#pending = this.#pending.slice(-1);
        return;
      }

      const body = this.#pending.slice(start + 2);
      const scan = scanPayload(body);

      if (scan.kind === 'incomplete') {
        // Unterminated so far. Retain it only while it could still become a sequence.
        this.#pending = body.length > MAX_OSC_PAYLOAD ? '' : this.#pending.slice(start);
        return;
      }

      if (scan.kind === 'terminated') this.#handle(body.slice(0, scan.index));
      // On 'aborted' the sequence was cancelled by a control character, exactly as a real
      // terminal treats it. Drop it and keep scanning from the cancel point, so a malformed
      // sequence cannot swallow the valid one that follows it.
      this.#pending = body.slice(scan.index + scan.consumed);
    }
  }

  #handle(payload: string): void {
    if (payload.length > MAX_OSC_PAYLOAD) return;

    if (payload.startsWith('7;')) {
      const cwd = parseFileUrl(payload.slice(2));
      if (cwd) this.#events.onCwd(cwd);
      return;
    }

    if (payload.startsWith('133;')) {
      const body = payload.slice(4);
      const mark = body[0];
      if (mark === 'A') this.#events.onPromptStart();
      else if (mark === 'C') this.#events.onCommandStart();
      else if (mark === 'D') {
        const code = Number(body.split(';')[1] ?? '0');
        this.#events.onCommandEnd(Number.isFinite(code) ? code : 0);
      }
    }
  }
}

/** Index of the next `ESC ]` introducer, or -1. */
function findIntroducer(s: string): number {
  for (let i = 0; i < s.length - 1; i++) {
    if (s.charCodeAt(i) === ESC && s[i + 1] === ']') return i;
  }
  return -1;
}

type Scan =
  | { kind: 'terminated'; index: number; consumed: number }
  | { kind: 'aborted'; index: number; consumed: number }
  | { kind: 'incomplete'; index: 0; consumed: 0 };

/**
 * Scan an OSC payload for its terminator.
 *
 * BEL and ST terminate. A bare CR, LF, or a fresh ESC that is not part of ST CANCELS the
 * sequence, which is what a real terminal does. Without that, one unterminated sequence
 * silently swallows every valid sequence after it.
 */
function scanPayload(s: string): Scan {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === BEL) return { kind: 'terminated', index: i, consumed: 1 };
    if (c === ESC) {
      if (s[i + 1] === '\\') return { kind: 'terminated', index: i, consumed: 2 };
      if (i + 1 >= s.length) return { kind: 'incomplete', index: 0, consumed: 0 };
      return { kind: 'aborted', index: i, consumed: 0 };
    }
    if (c === 0x0a || c === 0x0d) return { kind: 'aborted', index: i, consumed: 1 };
  }
  return { kind: 'incomplete', index: 0, consumed: 0 };
}

/** Must be an absolute path inside a file:// URL. Anything else is ignored entirely. */
function parseFileUrl(url: string): string | null {
  if (!url.startsWith('file://')) return null;
  const withoutScheme = url.slice('file://'.length);
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) return null;

  let path: string;
  try {
    path = decodeURIComponent(withoutScheme.slice(slash));
  } catch {
    return null;
  }
  if (!path.startsWith('/')) return null;
  if (path.length > 4096) return null;
  if (path.includes('\0')) return null;
  return path;
}
