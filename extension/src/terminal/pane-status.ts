import type { FaviconState } from './titles.js';

/**
 * One tab, one favicon, many panes.
 *
 * A tab has exactly one favicon and one title, so a workspace with several panes has to
 * reduce their states to one. The highest-priority state wins, because the whole point of a
 * background indicator is to surface the thing that needs a person.
 * See docs/06-chrome-integration.md §5.
 */

/** Most urgent first. Something waiting on a human outranks anything merely running. */
const PRIORITY: readonly FaviconState[] = [
  'approval',
  'failed',
  'waiting',
  'running',
  'idle',
  'disconnected',
];

export class PaneStatus {
  readonly #byPane = new Map<string, FaviconState>();

  set(paneId: string, state: FaviconState): void {
    this.#byPane.set(paneId, state);
  }

  forget(paneId: string): void {
    this.#byPane.delete(paneId);
  }

  retain(paneIds: Iterable<string>): void {
    const keep = new Set(paneIds);
    for (const id of [...this.#byPane.keys()]) if (!keep.has(id)) this.#byPane.delete(id);
  }

  get size(): number {
    return this.#byPane.size;
  }

  /** The state the tab as a whole should show. */
  effective(): FaviconState {
    if (this.#byPane.size === 0) return 'disconnected';
    for (const candidate of PRIORITY) {
      for (const state of this.#byPane.values()) {
        if (state === candidate) return candidate;
      }
    }
    return 'idle';
  }

  /** How many panes are in a given state, for a title suffix like "2 running". */
  countIn(state: FaviconState): number {
    let n = 0;
    for (const s of this.#byPane.values()) if (s === state) n++;
    return n;
  }
}

export { PRIORITY as STATUS_PRIORITY };
