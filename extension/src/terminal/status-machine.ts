import type { FaviconState } from './titles.js';

/**
 * What a tab shows, and for how long.
 *
 * The favicon is the only part of a terminal you can see from another tab, so the interesting
 * question is not what state a pane is in but what a person needs to still be able to learn
 * when they look back. Those are different: a command that succeeded two minutes ago is no
 * longer running, but "it finished" is exactly the thing they walked away to find out.
 *
 * Hence sticky states. `success` and `failed` persist until the tab is actually looked at, and
 * clear on the look rather than on a timer. A timer would mean the answer expires while nobody
 * is there to read it, which is precisely the case it exists for.
 *
 * See docs/06-chrome-integration.md.
 */

export interface PaneState {
  state: FaviconState;
  /** Set when a state is waiting to be seen, and cleared by the seeing. */
  sticky?: boolean;
}

/** Most urgent first. Something waiting on a person outranks anything merely running. */
export const PRIORITY: readonly FaviconState[] = [
  'approval',
  'waiting',
  'failed',
  'success',
  'done',
  'running',
  'idle',
  'disconnected',
];

/** States that mean "a person is needed", which are the only ones that pulse. */
export function needsAttention(state: FaviconState): boolean {
  return state === 'approval' || state === 'waiting';
}

/**
 * Whether a state waits to be seen.
 *
 * An outcome does. A condition does not: `running` describes the present and speaks for itself,
 * and `approval` clears when the approval is answered rather than when it is noticed.
 */
export function isSticky(state: FaviconState): boolean {
  return state === 'success' || state === 'failed' || state === 'done';
}

export class StatusMachine {
  readonly #panes = new Map<string, PaneState>();

  set(paneId: string, state: FaviconState): void {
    this.#panes.set(paneId, { state, ...(isSticky(state) ? { sticky: true } : {}) });
  }

  /**
   * A command finished. Success is a state of its own, not a return to idle.
   *
   * An absent exit code is not a zero. Without shell integration nothing observed how the
   * command ended, so the tab says it ended and declines to say more.
   */
  finished(paneId: string, exitCode: number | undefined): void {
    this.set(paneId, exitCode === undefined ? 'done' : exitCode === 0 ? 'success' : 'failed');
  }

  forget(paneId: string): void {
    this.#panes.delete(paneId);
  }

  retain(paneIds: Iterable<string>): void {
    const keep = new Set(paneIds);
    for (const id of [...this.#panes.keys()]) if (!keep.has(id)) this.#panes.delete(id);
  }

  get size(): number {
    return this.#panes.size;
  }

  stateOf(paneId: string): FaviconState | undefined {
    return this.#panes.get(paneId)?.state;
  }

  /**
   * The tab was looked at. Outcomes have now been delivered, so they stop being news.
   *
   * Returns whether anything changed, so the caller can avoid a redraw that would do nothing.
   */
  seen(): boolean {
    let changed = false;
    for (const [id, pane] of this.#panes) {
      if (pane.sticky === true) {
        // Back to idle rather than cleared: the pane is still there, it just has nothing left
        // to report. `failed` becoming idle is not forgetting the failure, which is on screen.
        this.#panes.set(id, { state: 'idle' });
        changed = true;
      }
    }
    return changed;
  }

  /** The state the tab as a whole should show, since a tab has exactly one favicon. */
  effective(): FaviconState {
    if (this.#panes.size === 0) return 'disconnected';
    for (const candidate of PRIORITY) {
      for (const pane of this.#panes.values()) if (pane.state === candidate) return candidate;
    }
    return 'idle';
  }

  /** How many panes are in a given state, for a title suffix like "2 running". */
  countIn(state: FaviconState): number {
    let n = 0;
    for (const pane of this.#panes.values()) if (pane.state === state) n++;
    return n;
  }
}

/**
 * What the title says after the process name.
 *
 * One line for a whole tab, so it answers the most urgent question and stops. A count is only
 * worth printing when there is more than one pane for it to distinguish.
 */
export function titleStatus(machine: StatusMachine, paneCount: number): string {
  if (machine.countIn('approval') > 0) return 'needs approval';
  if (machine.countIn('waiting') > 0) return 'waiting for you';
  if (machine.countIn('failed') > 0) return 'failed';
  if (machine.countIn('success') > 0) return 'done';
  if (machine.countIn('done') > 0) return 'finished';
  const running = machine.countIn('running');
  if (running > 0 && paneCount > 1) return `${String(running)} running`;
  if (paneCount > 1) return `${String(paneCount)} panes`;
  return '';
}
