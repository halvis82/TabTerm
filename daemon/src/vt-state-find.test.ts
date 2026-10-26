import { describe, expect, it } from 'vitest';
import { VtState } from './vt-state.js';

/**
 * Searching a terminal's history, for the find bar's All terminals: where the words appear,
 * newest first, and how many matches come after each, so the page can land on the same one.
 */
async function terminal(text: string, cols = 40): Promise<VtState> {
  const vt = new VtState(cols, 10, 1000);
  vt.write(text);
  await vt.flush();
  return vt;
}

describe('searching a terminal for words', () => {
  it('finds them newest first, ignoring case, and counts every match', async () => {
    const vt = await terminal('npm ERR! one\r\nfine\r\nnpm err! two err\r\n');
    const found = vt.find('err', 5);
    expect(found.count).toBe(3);
    expect(found.matches.map((m) => m.text)).toEqual(['npm err! two err', 'npm ERR! one']);
    // The newest line holds the last two matches; the one before it comes after them.
    expect(found.matches.map((m) => m.fromEnd)).toEqual([0, 2]);
  });

  it('finds words a line was wrapped through', async () => {
    const vt = await terminal(`${'x'.repeat(36)}needle here\r\n`);
    expect(vt.find('needle', 5).count).toBe(1);
  });

  it('gives a few lines however many matched, and says how many there were', async () => {
    const vt = await terminal(
      Array.from({ length: 20 }, (_, i) => `hit ${String(i)}`).join('\r\n'),
    );
    const found = vt.find('hit', 3);
    expect(found.matches).toHaveLength(3);
    expect(found.count).toBe(20);
    expect(found.matches[0]?.text).toBe('hit 19');
  });

  it('finds nothing where there is nothing', async () => {
    expect((await terminal('hello\r\n')).find('absent', 3)).toEqual({ matches: [], count: 0 });
  });
});
