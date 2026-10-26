/**
 * Progress a program reports for itself: `OSC 9 ; 4 ; state ; percent`, which Windows Terminal and
 * Ghostty show in the tab, and which some build tools, package managers and installers send.
 *
 *   0  no progress any more
 *   1  this far, as a percentage
 *   2  an error, at this percentage
 *   3  busy, with no idea how far
 *   4  paused, at this percentage
 *
 * The tab icon shows it as a ring filled that far. See `drawProgressFavicon` in titles.ts and
 * docs/06-chrome-integration.md.
 */
export type ProgressKind = 'normal' | 'error' | 'busy' | 'paused';

export interface Progress {
  kind: ProgressKind;
  /** 0 to 100. Meaningless for `busy`. */
  percent: number;
}

/**
 * What one `OSC 9` asks, from the part after `9;`. `null` for no progress, and `undefined` for an
 * `OSC 9` that is not about progress at all, such as iTerm2's notification, `OSC 9 ; text`.
 */
export function parseProgress(data: string): Progress | null | undefined {
  const m = /^4(?:;(\d*))?(?:;(\d*))?$/.exec(data);
  if (!m) return undefined;
  const state = Number(m[1] || '0');
  const percent = Math.max(0, Math.min(100, Number(m[2] || '0')));
  switch (state) {
    case 0:
      return null;
    case 1:
      return { kind: 'normal', percent };
    case 2:
      return { kind: 'error', percent };
    case 3:
      return { kind: 'busy', percent: 0 };
    case 4:
      return { kind: 'paused', percent };
    default:
      return undefined;
  }
}

/**
 * The one progress a tab of several panes shows: an error before anything else, since that is
 * the one to look at, then whichever is least far along, since that is how long the tab has left.
 * Busy with no idea how far is the ordinary running ring, so it is not shown here.
 */
export function tabProgress(all: Iterable<Progress>): Progress | null {
  let best: Progress | null = null;
  for (const p of all) {
    if (p.kind === 'busy') continue;
    if (!best) best = p;
    else if (p.kind === 'error' && best.kind !== 'error') best = p;
    else if ((p.kind === 'error') === (best.kind === 'error') && p.percent < best.percent) best = p;
  }
  return best;
}
