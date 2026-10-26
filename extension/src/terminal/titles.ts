import type { TitleFields } from '@tabterm/shared';

/**
 * Tab titles and favicons.
 *
 * The daemon supplies structured fields, never a display string, so a shell emitting a hostile
 * OSC title cannot inject formatting or markup into the tab. The frontend composes.
 * See docs/05-security.md and docs/06-chrome-integration.md §5.
 */

const HOME = /^\/Users\/[^/]+/;

/** `~/Projects/eeg` rather than `/Users/someone/Projects/eeg`. */
export function shortenPath(path: string): string {
  return path.replace(HOME, '~');
}

/**
 * What a tab is called, in one place, from what the tab actually holds.
 *
 * A tab strip is read sideways at a glance, so the useful half of a title is the front of it.
 * The rule is the same shape in every case: **what this is, then where it is**, and where is the
 * folder's own name rather than a path, because a path puts the answer at the end of a string
 * that has already been cut off.
 *
 *   the start screen          TabTerm
 *   one terminal              npm test — eeg-analysis
 *   an agent                  claude — eeg-analysis
 *   a template                review — eeg-analysis
 *   panes that match nothing  3 panes — eeg-analysis
 *   panes somebody named      training · eval — eeg-analysis
 *   a session somebody named  training run — claude — eeg-analysis
 *
 * A name goes first, in front of everything the tab would have been called anyway, because it is
 * the one part of a title that was chosen rather than derived. A tab strip is read from the left,
 * so the name has to be the half that survives being cut off.
 *
 * Only when the name belongs to the whole tab, which is a tab holding one pane. With several
 * panes there are several names, and the one on the focused pane would make the tab title change
 * as somebody clicked between them, which is a worse title than none.
 */
export function composeTitle(
  fields: TitleFields,
  status?: string,
  label?: string,
  /** The names given to the panes of a tab of several, in the order they are drawn. */
  paneLabels: readonly string[] = [],
): string {
  const where = fields.cwd ? basename(shortenPath(fields.cwd)) : (fields.repo ?? '');
  const named = (fields.paneCount ?? 1) > 1 ? joinLabels(paneLabels) : '';
  const what = named || describeWhat(fields);
  const parts = [label?.trim(), what, where].filter(Boolean);
  const base = parts.join(' — ');
  return status ? `${base} · ${status}` : base || 'TabTerm';
}

/** How long the names of a tab's panes may run before the rest are counted instead. */
export const LABELS_MAX = 48;

/**
 * The names given to a split tab's panes, joined: "training · eval · notes". Each name whole, as
 * many as fit in LABELS_MAX, and the rest counted, "training · eval +2", so a name is never cut
 * into something that reads like a different one. A tab of several panes is called by these
 * rather than by how many panes it has, since they are the part somebody chose.
 */
export function joinLabels(labels: readonly string[]): string {
  const names = labels.map((l) => l.trim()).filter((l) => l !== '');
  if (names.length === 0) return '';
  let out = names[0] ?? '';
  if (out.length > LABELS_MAX) out = `${out.slice(0, LABELS_MAX - 1)}…`;
  let shown = 1;
  for (const name of names.slice(1)) {
    const left = names.length - shown - 1;
    const next = `${out} · ${name}`;
    if (next.length + (left > 0 ? ` +${String(left)}`.length : 0) > LABELS_MAX) break;
    out = next;
    shown++;
  }
  return shown < names.length ? `${out} +${String(names.length - shown)}` : out;
}

/** Names of agent CLIs, which are worth saying instead of the command that started them. */
const AGENTS = new Set(['claude', 'codex']);

function describeWhat(fields: TitleFields): string {
  // Nothing open yet: this is the page you land on, and it has one name.
  if (fields.startScreen === true) return 'TabTerm';

  /**
   * A layout, named after the template it came from until it stops matching one.
   *
   * Closing a pane makes an arrangement that is no longer the template somebody opened, so
   * calling it by that name would be a title that has stopped being true. It falls back to the
   * count, which is what it now is.
   */
  const panes = fields.paneCount ?? 1;
  if (panes > 1) {
    return fields.template ?? `${String(panes)} panes`;
  }

  /*
   * An agent in the foreground is what the tab is, whatever started it.
   *
   * Asked for after a tab running Claude read `zsh`: that is the name of the shell the agent is
   * sitting in, and the shell is not what anybody is looking at. It comes from what is running
   * now rather than from a command event, so it survives a refresh, which is the other half of
   * what was asked.
   */
  if (fields.agent) return fields.agent;

  const running = fields.process ?? '';
  if (AGENTS.has(running)) return running;

  /**
   * The start of the last command, because the front of it is the part that is read.
   *
   * `npm run build --workspace daemon` says everything useful in its first two words, and a tab
   * strip will not show more than that anyway.
   */
  const last = fields.lastCommand?.trim();
  if (last) {
    /*
     * An agent is called by its name, whatever it was started with.
     *
     * The command that starts one carries the flags somebody configured, and a tab strip read
     * `<name> — claude --dangerously-skip-permissions`, where every character past the first word
     * is the same on every agent tab they have. The name is the part that identifies it.
     */
    const first = last.split(/\s+/)[0]?.split('/').pop() ?? '';
    if (AGENTS.has(first)) return first;
    return last.length > 24 ? `${last.slice(0, 24)}…` : last;
  }
  return running || fields.custom || 'zsh';
}

function basename(path: string): string {
  if (path === '~' || path === '/') return path;
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export type FaviconState =
  | 'idle'
  | 'running'
  /** Finished, with no exit code to say how. See docs/08-shell-integration.md. */
  | 'done'
  | 'success'
  | 'waiting'
  | 'approval'
  | 'failed'
  | 'disconnected'
  /**
   * The two halves of the attention flash, which alternate until somebody looks.
   *
   * Their own states rather than a reuse of `done` and `idle`, which is what the flash used to
   * alternate: two dark icons a shade apart, so the thing meant to catch your eye across twenty
   * tabs was invisible. These are saturated and differ in hue as well as in brightness.
   */
  | 'attention'
  | 'attention-alt';

/**
 * Color carries the state, and shape carries it again.
 *
 * At 16 pixels in a strip of twenty tabs, hue is the first thing read and the first thing lost:
 * roughly one man in twelve cannot separate the red from the green, and nobody can separate
 * either from a favicon they are not looking at directly. So success is a tick, failure is a
 * cross, and running is a caret. The color agrees with the shape rather than carrying it alone.
 */
const COLORS: Record<FaviconState, { bg: string; fg: string }> = {
  idle: { bg: '#2b2f3d', fg: '#8ab4f8' },
  // Bluer than idle on purpose: busy has to read as busy at 16 pixels, not as idle with a detail.
  running: { bg: '#1e2b4f', fg: '#8ab4f8' },
  done: { bg: '#2b2f3d', fg: '#9aa4bd' },
  success: { bg: '#1d3527', fg: '#6ee7a0' },
  waiting: { bg: '#5a3f18', fg: '#ffc857' },
  approval: { bg: '#5a3f18', fg: '#ffc857' },
  failed: { bg: '#4a2422', fg: '#ff8a7a' },
  disconnected: { bg: '#2b2f3d', fg: '#5b6070' },
  // Bright on purpose. This pair exists to be seen out of the corner of an eye.
  attention: { bg: '#1faa5a', fg: '#07281a' },
  'attention-alt': { bg: '#f2c033', fg: '#3a2a04' },
};

/**
 * Favicons are canvas-drawn data URLs.
 *
 * Measured: a hidden tab CAN repaint its favicon, and WebSocket delivery to it is completely
 * unthrottled. What a hidden tab cannot do is drive its own animation, because rAF is paused
 * and setInterval is throttled. So state changes are pushed, and animation only runs while
 * visible. See docs/10-limitations.md tier 1.1.
 */
/**
 * The tab's icon when nothing is happening: the product's own, rather than a drawn square.
 *
 * Every other state has to be drawn, because each is a glyph over a coloured ground and the pulse
 * changes between frames. Idle is not a state that needs drawing at all. It used to be the same
 * rounded rectangle in a quieter colour, which is a placeholder standing where an identity should
 * be: a tab full of terminals looked like nothing in particular.
 *
 * Returned as an extension URL rather than a data URL. The file is already packaged, a `<link>`
 * takes either, and re-encoding a PNG through a canvas on every idle transition would cost more
 * than it is worth.
 */
function packagedIcon(): string {
  try {
    return chrome.runtime.getURL('icon32.png');
  } catch {
    // No extension APIs, which is a test page or a preview. The drawn square is a fine fallback.
    return '';
  }
}

/** Frames in one turn of the busy ring. Enough that it turns rather than ticks. */
export const RING_STEPS = 16;
/** Frames in one breath of the waiting dot, at the ring's frame rate: two and a half seconds. */
const PULSE_STEPS = 40;
/** After this many frames every animation is back where it started, so no two keys draw alike. */
const CYCLE = 80;

/**
 * Every icon drawn, kept by what it shows.
 *
 * The ring turns sixteen times a second while its tab is in front, and a split icon is the same
 * few pictures over and over, so drawing each once is cheaper than encoding a PNG per frame.
 * Bounded, because the set of combinations is small but not fixed.
 */
const drawnIcons = new Map<string, string>();

function animates(state: FaviconState): boolean {
  return state === 'running' || state === 'waiting' || state === 'approval';
}

export function drawFavicon(state: FaviconState, phase = 0): string {
  if (state === 'idle') {
    const packaged = packagedIcon();
    if (packaged !== '') return packaged;
  }
  return drawIcon([state], phase);
}

/**
 * One icon for a tab whose panes are in different states: a slice for each, side by side.
 *
 * Asked for as "one shows the green checkmark and one shows still working", for any number of
 * panes. Panes with nothing to report take no slice, and two panes in the same state share one,
 * so a tab of three agents that have all finished is one solid tick. Two slices at most: at
 * sixteen pixels a third is a sliver of color with no shape left in it. The two are the most
 * urgent states present, most urgent on the left. See `StatusMachine.picture`.
 */
export function drawSplitFavicon(states: readonly FaviconState[], phase = 0): string {
  const shown = states.slice(0, 2);
  if (shown.length < 2) return drawFavicon(shown[0] ?? 'idle', phase);
  return drawIcon(shown, phase);
}

function drawIcon(states: readonly FaviconState[], phase: number): string {
  const moving = states.some(animates);
  const key = `${states.join('+')}:${String(moving ? phase % CYCLE : 0)}`;
  const kept = drawnIcons.get(key);
  if (kept !== undefined) return kept;

  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return '';

  g.save();
  roundRect(g, 0, 0, size, size, 7);
  g.clip();
  const width = size / states.length;
  states.forEach((state, i) => {
    g.fillStyle = COLORS[state].bg;
    g.fillRect(i * width, 0, width, size);
  });
  // A gap between the halves, so two states read as two rather than as one odd color.
  for (let i = 1; i < states.length; i++) g.clearRect(i * width - 1, 0, 2, size);
  g.restore();

  const scale = states.length === 1 ? 1 : 0.6;
  states.forEach((state, i) => {
    drawGlyph(g, state, phase, (i + 0.5) * width, size / 2, scale);
  });

  const drawn = canvas.toDataURL('image/png');
  if (drawnIcons.size > 400) drawnIcons.clear();
  drawnIcons.set(key, drawn);
  return drawn;
}

/**
 * The mark for one state, centered on (cx, cy), drawn in a 32 pixel box scaled by `scale`.
 *
 * Lines are kept thick when scaled down, because a half icon is eight pixels wide on screen and
 * a stroke scaled with it would vanish.
 */
function drawGlyph(
  g: CanvasRenderingContext2D,
  state: FaviconState,
  phase: number,
  cx: number,
  cy: number,
  scale: number,
): void {
  const { fg } = COLORS[state];
  const weight = Math.max(1, 0.8 / scale);
  g.save();
  g.translate(cx, cy);
  g.scale(scale, scale);
  g.translate(-16, -16);
  g.strokeStyle = fg;
  g.fillStyle = fg;
  g.lineWidth = 3 * weight;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  if (state === 'done') {
    /**
     * Finished, and nobody can say how.
     *
     * Without shell integration there is no exit code, so a tick would assert something no
     * evidence supports. A bar says the command is over and stops there, which is the whole of
     * what is known. See docs/08-shell-integration.md.
     */
    g.beginPath();
    g.moveTo(10, 16);
    g.lineTo(22, 16);
    g.stroke();
  } else if (state === 'success' || state === 'attention' || state === 'attention-alt') {
    /**
     * A tick, which reads as "done" without depending on the green being seen as green.
     *
     * The attention pair draws it too. It means finished rather than succeeded, which is what
     * the flash is raised for, and at sixteen pixels a shape that changes between frames would
     * read as two different tabs rather than as one asking for attention.
     */
    g.beginPath();
    g.moveTo(9, 17);
    g.lineTo(14, 22);
    g.lineTo(23, 10);
    g.stroke();
  } else if (state === 'failed') {
    g.beginPath();
    g.moveTo(11, 11);
    g.lineTo(21, 21);
    g.moveTo(21, 11);
    g.lineTo(11, 21);
    g.stroke();
  } else if (state === 'waiting' || state === 'approval') {
    /**
     * A dot that breathes, because the tab is asking for something.
     *
     * Pulsed by scaling rather than by fading the whole icon: a favicon that dims to nothing is
     * indistinguishable from a tab that has finished loading, and half the pulse would then be
     * a lie. This one is always visible and only changes size.
     */
    const beat = (Math.sin((phase / (PULSE_STEPS / 2)) * Math.PI) + 1) / 2;
    const radius = 4.5 + beat * 2.5;
    g.beginPath();
    g.arc(16, 16, radius, 0, Math.PI * 2);
    g.fill();
    if (state === 'approval') {
      // A ring around it, so the more urgent of the two is not distinguished by color alone.
      g.lineWidth = 2 * weight;
      g.beginPath();
      g.arc(16, 16, 11, 0, Math.PI * 2);
      g.stroke();
    }
  } else if (state === 'running') {
    /*
     * A ring with a gap that goes round: progress, the way every other application shows it.
     *
     * It was a caret with an underline that swept, which at 16 pixels was the idle icon with a
     * detail nobody could see, and "whenever a command is running or agent is working, that's
     * shown as progress through favicon" was asked for because it was not. The arc advances one
     * step per frame, only ever while the tab is visible; a hidden tab holds one steady frame.
     *
     * On a full, faint track, so one frame of it is a whole picture. The bare arc a hidden tab
     * was left holding read as a broken circle rather than as busy: "inconsistent and weird".
     * With the track drawn, a still frame is the familiar loading ring stopped in place.
     */
    const start = ((phase % RING_STEPS) / RING_STEPS) * Math.PI * 2 - Math.PI / 2;
    g.lineWidth = 3.5 * weight;
    g.globalAlpha = 0.3;
    g.beginPath();
    g.arc(16, 16, 9, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
    g.beginPath();
    g.arc(16, 16, 9, start, start + Math.PI * 0.8);
    g.stroke();
  } else {
    // A terminal prompt caret, which reads at 16 px far better than a glyph would.
    g.beginPath();
    g.moveTo(9, 11);
    g.lineTo(15, 16);
    g.lineTo(9, 21);
    g.stroke();
    g.beginPath();
    g.moveTo(18, 22);
    g.lineTo(24, 22);
    g.stroke();
  }
  g.restore();
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function applyFavicon(dataUrl: string): void {
  const link = document.getElementById('favicon');
  if (link instanceof HTMLLinkElement && dataUrl) link.href = dataUrl;
}
