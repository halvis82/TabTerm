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

export type FaviconState = 'idle' | 'running' | 'waiting' | 'approval' | 'failed' | 'disconnected';

const COLORS: Record<FaviconState, { bg: string; fg: string }> = {
  idle: { bg: '#2b2f3d', fg: '#8ab4f8' },
  running: { bg: '#2b2f3d', fg: '#8ae2a0' },
  waiting: { bg: '#2b2f3d', fg: '#e8c26a' },
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

  // A terminal prompt caret, which reads at 16 px far better than a glyph would.
  g.strokeStyle = fg;
  g.lineWidth = 3;
  g.lineCap = 'round';
  g.lineJoin = 'round';
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
