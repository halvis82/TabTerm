// How wide the page draws a character, which has to be how wide its author thought it was.
//
// An agent pads each cell of a table to a column count it works out itself, against a current
// width table. xterm's built-in one is from Unicode 6, where U+2705 is a single column, and every
// row of an agent's box drawing holding one came out a column short while the rows holding a
// warning sign stayed straight. The daemon side is covered by unit tests. This is the page.
//
// Width is invisible in text, so this reads it off wrapping instead: a run of two-column
// characters as long as the terminal is wide has to take two lines, and takes one if the page
// still believes they are one column.
import { openTerminal, evaluate, type, finish, waitFor, readScreen } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await waitFor(client, `(window.__tabterm.readViewport() ?? '').trim().length > 0`, 20000);

const geometry = await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())');
const cols = JSON.parse(String(geometry)).cols;

/*
 * Written as bytes rather than as the character itself.
 *
 * The shell echoes the command before running it, so a literal check mark in the command would put
 * a line of them on the screen that is not the output being measured.
 */
await type(
  client,
  `for i in $(seq 1 ${String(cols)}); do printf '\\xe2\\x9c\\x85'; done; printf '\\n'`,
);
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('✅')`, 20000);

const screen = String(await readScreen(client));
const runs = screen
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && [...line].every((ch) => ch === '✅'));

r.ok(
  'the run of check marks reached the screen',
  runs.length > 0,
  `screen had ${String(runs.length)} such lines`,
);

const first = [...(runs[0] ?? '')].length;
const expected = Math.floor(cols / 2);
r.ok(
  'a two-column character is drawn two columns wide, so the run wraps where it should',
  first === expected,
  `${String(cols)} of them in a ${String(cols)}-column terminal put ${String(first)} on the first line, wanted ${String(expected)}`,
);

r.ok(
  'and therefore takes more than one line',
  runs.length >= 2,
  `took ${String(runs.length)} line(s)`,
);

await finish();
r.done();
