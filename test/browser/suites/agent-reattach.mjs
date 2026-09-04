// A full-screen application still looks like itself after a reattach.
//
// This is the defect that made an agent unusable: after a refresh its screen came back as
// fragments of several different moments overlapping. The daemon's copy was clean the whole
// time, which is what said the fault was on this side.
//
// The cause was a width. A serialized screen is a picture with a width, and it was being written
// into a terminal of whatever size the pane happened to be, so every line wrapped somewhere else
// and every absolute cursor move landed in the wrong column. Attaching announced a hardcoded
// 80 by 24, which made the two widths differ almost every time.
//
// No agent is installed here, so a full-screen program is drawn directly with the same tools one
// uses: absolute positioning, a wide horizontal rule, and a box. What is checked is that the
// lines come back whole rather than interleaved.
import { openTerminal, evaluate, sleep, finish, type, waitFor, readScreen } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

/**
 * A screen drawn the way a full-screen application draws one.
 *
 * `tput cols` rather than a fixed number, so the rule is exactly the width of the terminal: that
 * is what makes a mismatched replay obvious, since a rule one column too long wraps and takes
 * every line after it with it.
 */
await type(
  client,
  'printf "%*s\\n" "$(tput cols)" "" | tr " " "-"; echo "AGENT-LINE-ONE"; echo "AGENT-LINE-TWO"\r',
);
await sleep(2500);

const ruleWidth = (screen) =>
  Math.max(0, ...screen.split('\n').map((l) => (/^-+$/.test(l.trim()) ? l.trim().length : 0)));

const before = String(await readScreen(client));
const cols = Number(await evaluate(client, 'window.__tabterm.geometry()?.cols ?? 0'));
r.ok(
  'the rule is drawn the full width of the terminal',
  ruleWidth(before) === cols && cols > 20,
  `rule ${String(ruleWidth(before))} of ${String(cols)} columns`,
);
r.ok(
  'and the lines after it are whole',
  before.includes('AGENT-LINE-ONE') && before.includes('AGENT-LINE-TWO'),
);

await evaluate(client, 'location.reload()');
await sleep(6000);
await waitFor(client, `(window.__tabterm?.readScreen() ?? '').includes('AGENT-LINE-TWO')`, 25000);
await sleep(1200);

const after = String(await readScreen(client));
const colsAfter = Number(await evaluate(client, 'window.__tabterm.geometry()?.cols ?? 0'));

/**
 * The rule comes back as one line that fits, rather than wrapped onto two.
 *
 * Not "exactly as wide as the terminal": a window that ends up a few columns wider after a
 * reload is ordinary, and a line drawn before that keeps the width it was drawn at, which is
 * what every terminal does. What is not ordinary is a screen replayed into a narrower grid,
 * where a full width rule wraps and takes everything after it along.
 */
const ruleLines = after.split('\n').filter((l) => /^-{10,}$/.test(l.trim())).length;
r.ok(
  'the rule comes back as one line that fits the terminal, not wrapped onto two',
  ruleLines === 1 && ruleWidth(after) <= colsAfter && colsAfter > 20,
  `${String(ruleLines)} rule lines, ${String(ruleWidth(after))} of ${String(colsAfter)} columns`,
);

/**
 * Each marker alone on its line, which is what "not interleaved" means.
 *
 * Matched exactly rather than by `includes`, because the command that printed them is echoed on
 * the screen too and contains both. A scrambled replay puts other text on these lines, so an
 * exact match finds neither.
 */
const alone = after
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l === 'AGENT-LINE-ONE' || l === 'AGENT-LINE-TWO');
r.ok(
  'and each line comes back alone on its own line rather than interleaved',
  alone.length === 2,
  JSON.stringify(
    after
      .split('\n')
      .filter((l) => l.includes('AGENT-LINE'))
      .slice(0, 4),
  ),
);

/**
 * A second, smaller view of the same session, which is what actually broke the agent.
 *
 * One PTY has one size, and with two views attached it is the smaller of them. The daemon worked
 * that out and told nobody, so the wider view went on rendering into columns the shell did not
 * know existed: every wrapped line and every absolute cursor move landed somewhere else. That is
 * a full-screen application coming back as fragments of several moments overlapping.
 *
 * The session had been open in two tabs at the time, which is how this was reached without
 * anybody asking for a mirror.
 */
// By pane id: the ids `transport` reports are shortened for reading, and a shortened session id
// attaches to nothing at all.
const paneId = String(await evaluate(client, `window.__tabterm.paneIds()[0] ?? ''`));
r.ok('a pane to look at from two places', paneId !== '');

// A second view, deliberately narrow, which is what makes the applied size smaller than this one.
await evaluate(client, `window.__tabterm.attachSecondView(${JSON.stringify(paneId)}, 40, 10)`);
await sleep(2500);

const grid = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify({ cols: window.__tabterm.geometry()?.cols ?? 0, rows: window.__tabterm.geometry()?.rows ?? 0 })`,
  ),
);
r.ok(
  'this view takes the size the terminal is really running at',
  grid.cols === 40 && grid.rows === 10,
  JSON.stringify(grid),
);

// And what is drawn now still fits the grid, rather than being written past its edge.
await type(client, 'printf "%*s\n" "$(tput cols)" "" | tr " " "="\r');
await sleep(2000);
const ruled = String(await readScreen(client));
const equals = Math.max(
  0,
  ...ruled.split('\n').map((l) => (/^=+$/.test(l.trim()) ? l.trim().length : 0)),
);
r.ok(
  'and a full width line drawn by the shell matches that grid exactly',
  equals === grid.cols,
  `${String(equals)} of ${String(grid.cols)}`,
);

await finish();
r.done();
