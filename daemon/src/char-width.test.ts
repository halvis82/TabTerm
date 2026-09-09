import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import serializeAddon from '@xterm/addon-serialize';
import { describe, expect, it } from 'vitest';
import { installCurrentWidths } from '@tabterm/shared';
import { VtState } from './vt-state.js';

const { Terminal } = headless;
const { Unicode11Addon } = unicode11;
const { SerializeAddon } = serializeAddon;

/**
 * How wide a character is, on the emulator the daemon actually runs.
 *
 * An agent pads each cell of a table to a column count it works out itself, against a current
 * width table. A terminal that disagrees puts that padding in the wrong place. With xterm's
 * built-in Unicode 6 table every row holding U+2705 came out one column short and the box drawing
 * went ragged, while the rows holding a warning sign stayed straight, because that one is a
 * text-default emoji both sides already counted as a single column.
 *
 * The daemon matters here as much as the page does. It keeps its own copy of the screen and ships
 * it as the replay payload, so a screen laid out under one table and redrawn under another does
 * not match itself. These checks replay the daemon's own snapshot to prove both copies agree.
 */

/** Where the agent's padding thinks characters end, which is a current table with VS16 at zero. */
function paddedWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const cp = character.codePointAt(0) ?? 0;
    if (cp === 0xfe0f) continue; // variation selector, no columns of its own
    width += cp === 0x2705 || cp === 0x274c ? 2 : 1;
  }
  return width;
}

const CELL = 12;

/** The shape of the table that went ragged: two emoji-default rows, one text-default row. */
function agentTable(): string[] {
  const rows = ['✅Nominal', '❌Replace', '⚠️ Watch'];
  return [
    `┌${'─'.repeat(CELL)}┐`,
    ...rows.map((r) => `│${r}${' '.repeat(CELL - paddedWidth(r))}│`),
    `└${'─'.repeat(CELL)}┘`,
  ];
}

/** The column each line's rightmost box character lands in, which is the whole question. */
function rightEdges(term: InstanceType<typeof Terminal>, lines: number): number[] {
  const edges: number[] = [];
  for (let row = 0; row < lines; row++) {
    const line = term.buffer.active.getLine(row);
    let edge = -1;
    for (let column = 0; column < term.cols; column++) {
      const chars = line?.getCell(column)?.getChars() ?? '';
      if (chars !== '' && '│┐┘'.includes(chars)) edge = column;
    }
    edges.push(edge);
  }
  return edges;
}

async function render(text: string, corrected: boolean): Promise<InstanceType<typeof Terminal>> {
  const term = new Terminal({ cols: 40, rows: 12, allowProposedApi: true });
  if (corrected) installCurrentWidths(term, new Unicode11Addon());
  // Writing is asynchronous. Reading the buffer without waiting reads an empty one, which looks
  // like every row agreeing rather than like nothing having happened yet.
  await new Promise<void>((resolve) => term.write(text, resolve));
  return term;
}

describe('character widths on the daemon emulator', () => {
  it('gives an emoji-presentation character the two columns its author padded for', async () => {
    const term = await render('✅X', true);
    expect(term.buffer.active.getLine(0)?.getCell(2)?.getChars()).toBe('X');
  });

  it('still gives a warning sign one column, which is what both sides already agreed on', async () => {
    const term = await render('⚠️X', true);
    expect(term.buffer.active.getLine(0)?.getCell(1)?.getChars()).toBe('X');
  });

  it('covers emoji added after the 2018 table was frozen', async () => {
    expect((await render('🫠X', true)).buffer.active.getLine(0)?.getCell(2)?.getChars()).toBe('X');
  });

  it('leaves a combining mark taking no columns of its own', async () => {
    expect((await render('éX', true)).buffer.active.getLine(0)?.getCell(1)?.getChars()).toBe('X');
  });

  it('draws the agent table with every row ending in the same column', async () => {
    const lines = agentTable();
    const edges = rightEdges(await render(lines.join('\r\n'), true), lines.length);
    expect(new Set(edges).size).toBe(1);
  });

  it('draws it ragged without the table, which is what makes the check above worth having', async () => {
    const lines = agentTable();
    const edges = rightEdges(await render(lines.join('\r\n'), false), lines.length);
    expect(new Set(edges).size).toBeGreaterThan(1);
  });
});

describe('the screen the daemon keeps', () => {
  /*
   * Serializing stores characters rather than columns, so a table laid out under the wrong widths
   * is re-wrapped by whoever draws it next and comes back looking right. Which is worth stating
   * plainly, because it means replay is not the reason the daemon needs the same table.
   *
   * The reason is that the daemon's buffer is a model of the same screen and the daemon reads it.
   * Widths decide where a line wraps, wrapping decides how many rows the content occupies, and
   * that decides what is still on screen once the rest has scrolled off. `hasRun` in
   * session-manager is exactly that question, counted off a snapshot taken without scrollback.
   */
  it('scrolls the same content off screen as the page does', async () => {
    // Twelve two-column characters in a six-column, two-row terminal: half of them have scrolled
    // off. Under a table that calls them one column, everything still fits and nothing has.
    const written = '✅'.repeat(12);
    const vt = new VtState(6, 2, 100);
    vt.write(written);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const daemonScreen = vt.snapshot(0).screen;
    vt.dispose();

    const page = new Terminal({ cols: 6, rows: 2, scrollback: 100, allowProposedApi: true });
    installCurrentWidths(page, new Unicode11Addon());
    const serializer = new SerializeAddon();
    page.loadAddon(serializer);
    await new Promise<void>((resolve) => page.write(written, resolve));

    expect(daemonScreen).toBe(serializer.serialize({ scrollback: 0 }));
    expect(daemonScreen).toBe('✅'.repeat(6));
  });
});
