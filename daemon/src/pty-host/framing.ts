/**
 * Framing for the socket between the daemon and the PTY host.
 *
 * Its own codec rather than the WebSocket one from `shared/`, because these are different
 * boundaries with different lifetimes. The wire protocol is a public contract with an extension
 * that updates separately; this is private, local, and between two processes that ship together.
 * Coupling them would mean a change for a browser could not be made without thinking about a
 * process that has no browser in it.
 *
 * Two kinds only. Control is JSON, because it is low volume and worth being able to read in a
 * log. Output is raw bytes with a small header, because it is the high volume path and a
 * terminal's bytes must arrive exactly as they left, base64 and JSON escaping included.
 */

export const FRAME_CONTROL = 0x00;
export const FRAME_OUTPUT = 0x01;

/** A frame larger than this is a bug or an attack, and is refused before allocation. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface OutputFrame {
  sessionId: string;
  /**
   * Monotonic per session, assigned by the host.
   *
   * The host owns this rather than the daemon, because it is what lets a restarted daemon say
   * "I have everything up to N" and receive exactly the rest. A number the daemon owned would
   * reset with the daemon, which is the case it exists to survive.
   */
  seq: number;
  data: Uint8Array;
}

function frame(kind: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length + 1);
  out[4] = kind;
  out.set(body, 5);
  return out;
}

export function controlFrame(message: unknown): Uint8Array {
  return frame(FRAME_CONTROL, new TextEncoder().encode(JSON.stringify(message)));
}

export function outputFrame(f: OutputFrame): Uint8Array {
  const id = new TextEncoder().encode(f.sessionId);
  const body = new Uint8Array(1 + id.length + 8 + f.data.length);
  body[0] = id.length;
  body.set(id, 1);
  // A double holds an integer exactly up to 2^53, which at any plausible byte rate is longer
  // than any machine stays up.
  new DataView(body.buffer).setFloat64(1 + id.length, f.seq);
  body.set(f.data, 1 + id.length + 8);
  return frame(FRAME_OUTPUT, body);
}

export type Decoded =
  { kind: 'control'; message: unknown } | { kind: 'output'; frame: OutputFrame };

/**
 * Pull whole frames out of a stream buffer.
 *
 * A socket delivers arbitrary slices, so this returns what is complete and how many bytes were
 * consumed. The caller keeps the remainder. Getting this wrong shows up as a terminal that
 * works until output arrives faster than it is read, which is exactly when anybody notices.
 */
export function decodeFrames(buffer: Uint8Array): { frames: Decoded[]; consumed: number } {
  const frames: Decoded[] = [];
  let at = 0;

  while (buffer.length - at >= 5) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + at);
    const length = view.getUint32(0);
    if (length > MAX_FRAME_BYTES) throw new Error(`frame too large: ${String(length)}`);
    if (buffer.length - at - 4 < length) break;

    const kind = buffer[at + 4];
    const body = buffer.subarray(at + 5, at + 4 + length);

    if (kind === FRAME_CONTROL) {
      frames.push({ kind: 'control', message: JSON.parse(new TextDecoder().decode(body)) });
    } else if (kind === FRAME_OUTPUT) {
      const idLength = body[0] ?? 0;
      const sessionId = new TextDecoder().decode(body.subarray(1, 1 + idLength));
      const seq = new DataView(body.buffer, body.byteOffset + 1 + idLength).getFloat64(0);
      frames.push({
        kind: 'output',
        frame: { sessionId, seq, data: body.subarray(1 + idLength + 8) },
      });
    }
    // An unknown kind is skipped rather than fatal. A newer host talking to an older daemon
    // should degrade, not deadlock.

    at += 4 + length;
  }

  return { frames, consumed: at };
}
