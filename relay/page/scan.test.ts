import qrcode from 'qrcode-generator';
import { describe, expect, it } from 'vitest';
import { readCode } from './scan.js';

/**
 * Scan on the relay page reads the code Settings draws, the same way: the same library, the same
 * error correction, a link of the same length, as pixels a camera might give.
 */
const link =
  'https://tabterm-relay.example.workers.dev/#pair=r_0123456789abcdefghij.d_0123456789abcdef.' +
  'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

function frame(text: string, opts: { invert?: boolean; scale?: number; pad?: number } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const scale = opts.scale ?? 6;
  const pad = opts.pad ?? 40;
  const size = n * scale + pad * 2;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor((x - pad) / scale);
      const my = Math.floor((y - pad) / scale);
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.isDark(my, mx);
      const v = dark !== Boolean(opts.invert) ? 0 : 255;
      rgba.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  return { rgba, size };
}

describe('scanning a pairing code', () => {
  it('reads the link the code holds', () => {
    const { rgba, size } = frame(link);
    expect(readCode(rgba, size, size)).toBe(link);
  });

  it('reads it light on dark too', () => {
    const { rgba, size } = frame(link, { invert: true });
    expect(readCode(rgba, size, size)).toBe(link);
  });

  it('reads it small in the frame', () => {
    const { rgba, size } = frame(link, { scale: 3, pad: 200 });
    expect(readCode(rgba, size, size)).toBe(link);
  });

  it('finds nothing where there is no code', () => {
    const size = 200;
    const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
    expect(readCode(rgba, size, size)).toBeNull();
  });
});
