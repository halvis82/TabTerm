import { describe, expect, it } from 'vitest';
import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { installCurrentWidths } from './char-width.js';

const { Terminal } = headless;
const { Unicode11Addon } = unicode11;

/**
 * Keeping the width table right must stay nearly free.
 *
 * Width is read for every character of output, on the daemon and again in every pane, so what
 * this costs is multiplied by everything a terminal ever prints. Measured before this was cached:
 * sixteen megabytes through a server-side terminal cost 700 ms of processor with the corrected
 * table installed and 228 ms with xterm's own, so two thirds of the cost of keeping a screen was
 * asking the same question about the same characters again.
 *
 * Written as a ratio rather than a number of milliseconds. An absolute budget measures the
 * machine, and this file has to mean the same thing on a busy laptop as on an idle one. What it
 * asserts is that correctness is not what makes the terminal slow: installing the table may cost
 * a little, and must not cost multiples.
 */
const payload = Buffer.from(
  Array.from({ length: 200 }, () => 'x'.repeat(119) + '\n').join(''),
  'utf8',
);

async function cost(make: () => InstanceType<typeof Terminal>): Promise<number> {
  const term = make();
  const rounds = Math.ceil((4 * 1024 * 1024) / payload.length);
  const started = process.cpuUsage();
  for (let i = 0; i < rounds; i++) term.write(payload);
  await new Promise<void>((r) => term.write('', () => r()));
  const used = process.cpuUsage(started);
  term.dispose();
  return (used.user + used.system) / 1000;
}

describe('what the width table costs to keep right', () => {
  it('is near what xterm’s own table costs, rather than a multiple of it', async () => {
    const plain = () =>
      new Terminal({ cols: 120, rows: 40, scrollback: 1000, allowProposedApi: true });
    const corrected = () => {
      const term = plain();
      installCurrentWidths(term, new Unicode11Addon());
      return term;
    };

    // Once through each first, so neither is paying for the other's warm up.
    await cost(plain);
    await cost(corrected);

    const withoutTable = await cost(plain);
    const withTable = await cost(corrected);
    const ratio = withTable / Math.max(1, withoutTable);
    // It was 3.1x before the table was cached, and is about 1x after. Two is a wide gate that
    // still catches the lookup going back to being worked out per character.
    expect(ratio).toBeLessThan(2);
  }, 120000);
});
