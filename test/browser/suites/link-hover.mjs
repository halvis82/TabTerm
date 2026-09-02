// A path says it is clickable only while the pointer is actually on it.
//
// The cursor used to change for the whole screen the moment Command went down, which announced
// that something was clickable without saying what, and said it over blank space too.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo /Users/halvis82/Documents\r');
await sleep(2800);

// Resolution happens as the output is printed. xterm caches what a link provider answered for a
// line and only asks again when the pointer changes line, so an answer that arrives after the
// first hover never gets used: the path stayed inert until the pointer left and came back.
const resolved = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify((window.__tabterm.resolvedPaths() ?? []).map((p) => p.candidate))`,
  ),
);
r.ok(
  'a printed path is resolved before anybody hovers it',
  resolved.includes('/Users/halvis82/Documents'),
  resolved.join(' | '),
);

const geo = JSON.parse(await evaluate(client, `JSON.stringify(window.__tabterm.geometry())`));
/**
 * Move the pointer the way a hand does.
 *
 * A single event at the destination is not how a pointer arrives anywhere, and xterm asks its
 * link providers about the line under the pointer as it moves. One sparse event left the answer
 * to chance, which showed up as this check passing alone and failing in a full run.
 */
const hover = async (col, row) => {
  const y = Math.round(geo.top + row * geo.cellHeight);
  for (const step of [-2, -1, 0]) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(geo.left + (col + step) * geo.cellWidth),
      y,
      modifiers: 4, // Meta
    });
    await sleep(120);
  }
  await sleep(400);
};

/**
 * Wait for the link to be recognized rather than assuming a fixed delay.
 *
 * xterm asks its link provider as the pointer moves and paints the result when the answer comes
 * back, which was measured at around 400 ms on a cold page. A fixed sleep sat on that boundary,
 * so this check passed alone and failed in a full run.
 */
const pointerWithin = async (ms) => {
  for (let waited = 0; waited < ms; waited += 200) {
    if (await pointer()) return true;
    await sleep(200);
  }
  return false;
};
const pointer = () => evaluate(client, `!!document.querySelector('.xterm-cursor-pointer')`);

/**
 * Find the row the path is actually on.
 *
 * It was hardcoded, and on a cold page the prompt and the output can land a line lower, so the
 * hover went to blank space and the check failed for a reason that had nothing to do with links.
 */
const lines = (await evaluate(client, `window.__tabterm.readScreen()`)).split('\n');
const pathRow = lines.findIndex((l) => l.trim() === '/Users/halvis82/Documents');
const blankRow = lines.findIndex((l, i) => i > pathRow + 1 && l.trim() === '');
r.ok('the printed path is on screen', pathRow >= 0, `row ${String(pathRow)}`);

// Park the pointer away first. A mouse event at the coordinates the pointer already occupies is
// not a move, so a previous run leaving it on the path made the next hover deliver nothing.
await hover(60, pathRow + 6.5);

await hover(5, pathRow + 0.5);
r.ok(
  'holding Command over a path shows it is clickable',
  await pointerWithin(3000),
  `modifier seen: ${String(await evaluate(client, "document.body.classList.contains('cmd-held')"))}`,
);

await hover(3, (blankRow >= 0 ? blankRow : pathRow + 4) + 0.5);
// Long enough that it would have appeared by now, since this asserts an absence.
await sleep(1200);
r.ok('and blank space on the same screen does not', !(await pointer()));

// Without the modifier nothing is a link, whatever the pointer is over.
await client.send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: Math.round(geo.left + 5 * geo.cellWidth),
  y: Math.round(geo.top + (pathRow + 0.5) * geo.cellHeight),
  modifiers: 0,
});
await sleep(1500);
r.ok('without Command a path is inert', !(await pointer()));

await finish();
r.done();
