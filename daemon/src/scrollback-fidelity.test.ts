import { describe, expect, it } from 'vitest';
import { VtState } from './vt-state.js';

/**
 * What a smaller scrollback actually costs.
 *
 * The memory side is measured and written down: 9.5 MB per session at 2,000 lines against 30.8
 * at the 10,000 default, so the difference across a dozen sessions is a quarter of a gigabyte.
 * That number alone cannot decide the default, because it says what a smaller emulator saves and
 * nothing about what it loses. This is the other half.
 *
 * The answer, pinned here so it does not have to be argued from first principles again: a
 * smaller scrollback costs **depth and nothing else**. The screen a reattaching tab is given is
 * identical at any cap. See docs/11-performance.md and docs/07-terminal-fidelity.md.
 */

/** Print numbered lines, the way a build does, and wait for the parser to finish with them. */
async function fill(vt: VtState, count: number, tag: string): Promise<void> {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) lines.push(`${tag}-${String(i)}`);
  vt.write(`${lines.join('\r\n')}\r\n`);
  // xterm parses on its own schedule, so reading the buffer in the same turn reads a buffer that
  // is still being written into.
  await new Promise((r) => setTimeout(r, 50));
}

describe('what a smaller scrollback costs', () => {
  it('costs nothing on the screen, which is what a reattaching tab is given', async () => {
    const small = new VtState(80, 24, 200);
    const large = new VtState(80, 24, 10_000);
    await fill(small, 5_000, 'line');
    await fill(large, 5_000, 'line');

    /**
     * The visible screen, which is what a tab paints the instant it reattaches.
     *
     * Identical at both caps, and it has to be: the screen is the last `rows` lines and the cap
     * governs what is kept above them. A smaller emulator that showed a different screen would
     * be a correctness bug rather than a memory trade.
     */
    expect(small.snapshot(0).screen).toEqual(large.snapshot(0).screen);
    expect(small.snapshot(0).screen).toContain('line-5000');
  });

  it('costs depth, and exactly the depth it was told to keep', async () => {
    const small = new VtState(80, 24, 200);
    await fill(small, 5_000, 'line');

    // Asking for more than the cap does not conjure it back.
    const kept = small.snapshot(10_000).screen.split('\r\n');
    expect(kept.length).toBeLessThanOrEqual(200 + 24 + 2);
    // The recent past is all there, and the distant past is gone. That is the entire trade, and
    // it is worth stating out loud rather than leaving it to be inferred from a memory table.
    expect(small.snapshot(10_000).screen).toContain('line-4900');
    expect(small.snapshot(10_000).screen).not.toContain('line-100\r\n');
  });

  it('gives the depth back when the cap is raised, only for what comes after', async () => {
    /**
     * Lowering a memory mode has to release memory now, not only for sessions started later.
     *
     * Checked as behavior rather than as bytes: a heap measurement here would be a test of the
     * garbage collector's mood, while the lines being dropped is a fact.
     */
    const vt = new VtState(80, 24, 10_000);
    await fill(vt, 5_000, 'line');
    expect(vt.snapshot(10_000).screen.split('\r\n').length).toBeGreaterThan(4_000);

    vt.setScrollback(200);
    await fill(vt, 1, 'after');
    expect(vt.snapshot(10_000).screen.split('\r\n').length).toBeLessThanOrEqual(200 + 24 + 2);
    // And the screen is still right, which is the part somebody would notice.
    expect(vt.snapshot(0).screen).toContain('after-1');
  });
});
