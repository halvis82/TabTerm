/**
 * Ways back from the two gestures that take a pane away.
 *
 * Closing a pane and moving one to its own tab are both easy to do by accident and were both
 * final. A gesture with no way back is a gesture people learn to be careful with, which is the
 * wrong feeling for a button in the corner of a pane.
 *
 * The two are one mechanism because they are the same promise: for the next few minutes, that
 * terminal is still there and one keystroke brings it back. Only the sentence on the button and
 * what it sends differ.
 *
 * The model lives here, away from the DOM, because the interesting parts are what expires, what
 * order things come back in, and what happens when the same terminal is offered twice. All three
 * are testable without a browser.
 */

export interface UndoOffer {
  /** The terminal this offer is about, which is the thing being brought back. */
  sessionId: string;
  kind: 'closed' | 'detached';
  /** Where it went, for a detached pane. Empty for a closed one, which went nowhere. */
  workspaceId?: string;
  /** What the pane was showing, so the button can name it. */
  title: string;
  /** When it was offered, in milliseconds. */
  at: number;
}

/** Five minutes, which is the daemon's own window for holding a closed pane. */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

export class UndoStack {
  #offers: UndoOffer[] = [];
  /** How many are kept, which is the number of panes the tab had. */
  #depth = 1;

  /**
   * The stack is as deep as the tab is wide.
   *
   * Asked for that way, and it is the right bound: closing every pane in a four pane tab should
   * be undoable four times, and there is nothing to undo beyond the panes that existed.
   */
  setDepth(panes: number): void {
    this.#depth = Math.max(1, panes);
    this.#trim();
  }

  /**
   * Offer a way back, most recent first.
   *
   * The same session offered twice replaces its earlier entry rather than appearing twice: two
   * buttons for one terminal, the second of which cannot work, is worse than one.
   */
  push(offer: UndoOffer): void {
    this.#offers = [offer, ...this.#offers.filter((o) => o.sessionId !== offer.sessionId)];
    this.#trim();
  }

  /** Drop one, because it was taken, dismissed, or turned out to be impossible. */
  remove(sessionId: string): void {
    this.#offers = this.#offers.filter((o) => o.sessionId !== sessionId);
  }

  clear(): void {
    this.#offers = [];
  }

  /** What is still on offer at this moment, newest first, expired ones gone. */
  live(now = Date.now()): UndoOffer[] {
    this.#offers = this.#offers.filter((o) => now - o.at < UNDO_WINDOW_MS);
    return [...this.#offers];
  }

  /** The one Command+Z means: the most recent thing that has not expired. */
  next(now = Date.now()): UndoOffer | undefined {
    return this.live(now)[0];
  }

  #trim(): void {
    if (this.#offers.length > this.#depth) this.#offers = this.#offers.slice(0, this.#depth);
  }
}

/** What the button says, which has to name the terminal rather than the gesture. */
export function offerLabel(offer: UndoOffer, home = ''): string {
  const where = shortPath(offer.title, home);
  if (offer.kind === 'detached') return where ? `Move ${where} back` : 'Move it back';
  return where ? `Reopen ${where}` : 'Reopen the pane';
}

/**
 * The last part of a path, which is what identifies a pane at a glance.
 *
 * The home directory is the exception: its last part is the account name, and "Reopen halvis82"
 * names a person rather than a place. It is written the way a shell writes it.
 */
function shortPath(path: string, home = ''): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return '';
  if (home !== '' && trimmed === home.replace(/\/+$/, '')) return '~';
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return name === '' ? trimmed : name;
}
