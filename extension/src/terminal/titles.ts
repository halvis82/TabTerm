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

export function composeTitle(fields: TitleFields, status?: string): string {
  const where = fields.repo ?? (fields.cwd ? basename(shortenPath(fields.cwd)) : '');
  const what = fields.process ?? fields.custom ?? 'zsh';
  const parts = [what, where].filter(Boolean);
  const base = parts.join(' — ');
  return status ? `${base} · ${status}` : base || 'Terminal';
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
  | 'disconnected';

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
  running: { bg: '#2b2f3d', fg: '#8ab4f8' },
  done: { bg: '#2b2f3d', fg: '#9aa4bd' },
  success: { bg: '#1d3527', fg: '#6ee7a0' },
  waiting: { bg: '#5a3f18', fg: '#ffc857' },
  approval: { bg: '#5a3f18', fg: '#ffc857' },
  failed: { bg: '#4a2422', fg: '#ff8a7a' },
  disconnected: { bg: '#2b2f3d', fg: '#5b6070' },
};

/**
 * Favicons are canvas-drawn data URLs.
 *
 * Measured: a hidden tab CAN repaint its favicon, and WebSocket delivery to it is completely
 * unthrottled. What a hidden tab cannot do is drive its own animation, because rAF is paused
 * and setInterval is throttled. So state changes are pushed, and animation only runs while
 * visible. See docs/10-limitations.md tier 1.1.
 */
export function drawFavicon(state: FaviconState, phase = 0): string {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return '';

  const { bg, fg } = COLORS[state];

  g.fillStyle = bg;
  roundRect(g, 0, 0, size, size, 7);
  g.fill();

  g.strokeStyle = fg;
  g.fillStyle = fg;
  g.lineWidth = 3;
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
    return canvas.toDataURL('image/png');
  }

  if (state === 'success') {
    // A tick, which reads as "done" without depending on the green being seen as green.
    g.beginPath();
    g.moveTo(9, 17);
    g.lineTo(14, 22);
    g.lineTo(23, 10);
    g.stroke();
    return canvas.toDataURL('image/png');
  }

  if (state === 'failed') {
    g.beginPath();
    g.moveTo(11, 11);
    g.lineTo(21, 21);
    g.moveTo(21, 11);
    g.lineTo(11, 21);
    g.stroke();
    return canvas.toDataURL('image/png');
  }

  if (state === 'waiting' || state === 'approval') {
    /**
     * A dot that breathes, because the tab is asking for something.
     *
     * Pulsed by scaling rather than by fading the whole icon: a favicon that dims to nothing is
     * indistinguishable from a tab that has finished loading, and half the pulse would then be
     * a lie. This one is always visible and only changes size.
     */
    const beat = (Math.sin((phase / 6) * Math.PI) + 1) / 2;
    const radius = 4.5 + beat * 2.5;
    g.beginPath();
    g.arc(16, 16, radius, 0, Math.PI * 2);
    g.fill();
    if (state === 'approval') {
      // A ring around it, so the more urgent of the two is not distinguished by color alone.
      g.lineWidth = 2;
      g.beginPath();
      g.arc(16, 16, 11, 0, Math.PI * 2);
      g.stroke();
    }
    return canvas.toDataURL('image/png');
  }

  // A terminal prompt caret, which reads at 16 px far better than a glyph would.
  g.beginPath();
  g.moveTo(9, 11);
  g.lineTo(15, 16);
  g.lineTo(9, 21);
  g.stroke();

  if (state === 'running') {
    // A short underline that sweeps, only ever advanced while the tab is visible.
    const width = 10;
    const travel = (phase % 12) / 12;
    g.beginPath();
    g.moveTo(18, 22);
    g.lineTo(18 + width * travel, 22);
    g.stroke();
  } else {
    g.beginPath();
    g.moveTo(18, 22);
    g.lineTo(24, 22);
    g.stroke();
  }

  return canvas.toDataURL('image/png');
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
