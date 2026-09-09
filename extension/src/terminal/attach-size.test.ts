import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What a page is allowed to claim about its size when it attaches.
 *
 * Nothing settled, ever. A page that has just loaded measures its pane before the layout is done
 * and gets a box a scrollbar narrower than the one it will have a second later: `attach 187x44`
 * went out where the truth was `195x44`, and the session was resized to both.
 *
 * Eight columns is not cosmetic. Narrowing a terminal rewraps every wrapped line in its history and
 * widening rewraps them back, so opening a tab reflowed a whole session twice for a size nobody
 * ever had, leaving fragments of earlier frames stranded between the current ones. That is what an
 * agent's output looked like after its tab was reopened.
 *
 * Checked in the source because the effect is invisible from outside: the size ends up correct
 * either way, and what differs is a transient nobody watching the end state can see. Reverting the
 * fix passed every browser suite there is.
 */
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'terminal-page.ts'),
  'utf8',
);

describe('the size an attach claims', () => {
  it('is always marked as not yet settled', () => {
    const fn = source.slice(
      source.indexOf('function attachSize()'),
      source.indexOf('function attachSize()') + 2400,
    );
    const measured = fn.slice(fn.indexOf('const measured'), fn.indexOf('const cell'));
    expect(
      measured,
      'a measurement taken before the layout has settled must not be applied to the session',
    ).toContain('estimated: true');
    expect(
      /return measured;/.test(measured),
      'returning the raw measurement is what resized the terminal twice on every tab open',
    ).toBe(false);
  });

  it('still sends a number, because a new session has nothing else to go on', () => {
    const fn = source.slice(
      source.indexOf('function attachSize()'),
      source.indexOf('function attachSize()') + 2400,
    );
    expect(fn).toContain('cols:');
    expect(fn).toContain('rows:');
  });
});
