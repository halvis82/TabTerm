/**
 * Keystrokes typed at an agent that is still starting, held rather than lost.
 *
 * Resuming a conversation spawns an agent CLI that takes a few seconds to be ready: it reads a
 * transcript that can be tens of megabytes, sets the terminal up, and draws an interface. Its
 * input box appears well before it will act on anything, and a prompt typed into that window comes
 * back with its first characters missing and the turn reported as `[Request interrupted by user]`.
 *
 * Measured rather than assumed. Through the product, typing as soon as the box appeared: four of
 * nine attempts came back interrupted, at human typing speed as well as at a synthetic one. The
 * same conversations, resumed in a plain terminal and typed into at the same moment, answered
 * every time, eight for eight. So this is something about a session this product starts, not about
 * typing early at an agent in general. The cause is not found yet, and this is not a claim to have
 * found it: it is the difference between losing what somebody typed and delivering it.
 *
 * **Held, never dropped.** What is typed is kept and sent the moment the pane is judged ready, in
 * the order it was typed. Losing a prompt is the thing being fixed; swallowing one silently would
 * be the same fault wearing different clothes.
 *
 * Only a session this page **started an agent in**, and only for the first few seconds of it. A
 * shell is ready when it prints its prompt and nothing here goes near one.
 */

/** How long the pane must have been quiet, after speaking, before it counts as ready. */
const QUIET_MS = 900;

/** However quiet it is, nothing is delivered sooner than this after the session began. */
const FLOOR_MS = 2000;

/**
 * And nothing is held longer than this, whatever the pane is doing.
 *
 * An agent that prints continuously from the moment it starts would otherwise never look quiet,
 * and somebody's typing would sit here forever. Late delivery is a bad outcome; no delivery is a
 * worse one.
 */
const CAP_MS = 12_000;

interface Held {
  /** When the hold began, which is when the session was created. */
  since: number;
  /** When the pane last printed anything, or 0 while it has not spoken at all. */
  spokeAt: number;
  text: string;
}

export class HeldInput {
  readonly #held = new Map<string, Held>();

  /** Hold anything typed at this session until it is ready. */
  begin(sessionId: string, now: number): void {
    this.#held.set(sessionId, { since: now, spokeAt: 0, text: '' });
  }

  /** Whether anything typed at this session is being held right now. */
  holding(sessionId: string): boolean {
    return this.#held.has(sessionId);
  }

  /** Take what was typed. False when this session is not being held, so the caller sends it. */
  take(sessionId: string, data: string): boolean {
    const held = this.#held.get(sessionId);
    if (!held) return false;
    held.text += data;
    return true;
  }

  /** The pane printed something, which is what the quiet is measured from. */
  spoke(sessionId: string, now: number): void {
    const held = this.#held.get(sessionId);
    if (held) held.spokeAt = now;
  }

  /**
   * Sessions that are ready, with whatever was typed at them. Each is released once.
   *
   * A session that was never typed at is released just the same, and gives back an empty string:
   * the hold is over and the caller stops asking about it.
   */
  release(now: number): { sessionId: string; text: string }[] {
    const out: { sessionId: string; text: string }[] = [];
    for (const [sessionId, held] of this.#held) {
      const waitedLongEnough = now - held.since >= FLOOR_MS;
      const settled = held.spokeAt > 0 && now - held.spokeAt >= QUIET_MS;
      const givenUp = now - held.since >= CAP_MS;
      if ((waitedLongEnough && settled) || givenUp) {
        out.push({ sessionId, text: held.text });
        this.#held.delete(sessionId);
      }
    }
    return out;
  }

  /** Stop holding for a session that has gone, and say what was typed at it. */
  drop(sessionId: string): string {
    const held = this.#held.get(sessionId);
    this.#held.delete(sessionId);
    return held?.text ?? '';
  }

  /** How many sessions are being held, so a caller can stop its timer when none are. */
  get size(): number {
    return this.#held.size;
  }
}
