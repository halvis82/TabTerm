// A path says it is clickable only while the pointer is actually on it.
//
// The cursor used to change for the whole screen the moment Command went down, which announced
// that something was clickable without saying what, and said it over blank space too.
import { openTerminal, evaluate, sleep, type, finish } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await sleep(4500);
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
const hover = async (col, row) => {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(geo.left + col * geo.cellWidth),
    y: Math.round(geo.top + row * geo.cellHeight),
    modifiers: 4, // Meta
  });
  await sleep(700);
};
const pointer = () => evaluate(client, `!!document.querySelector('.xterm-cursor-pointer')`);

// Park the pointer away first. A mouse event at the coordinates the pointer already occupies is
// not a move, so a previous run leaving it on the path made the next hover deliver nothing.
await hover(60, 10.5);

await hover(5, 2.5);
r.ok('holding Command over a path shows it is clickable', await pointer());

await hover(3, 6.5);
r.ok('and blank space on the same screen does not', !(await pointer()));

// Without the modifier nothing is a link, whatever the pointer is over.
await client.send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: Math.round(geo.left + 5 * geo.cellWidth),
  y: Math.round(geo.top + 2.5 * geo.cellHeight),
  modifiers: 0,
});
await sleep(700);
r.ok('without Command a path is inert', !(await pointer()));

await finish(client);
r.done();
