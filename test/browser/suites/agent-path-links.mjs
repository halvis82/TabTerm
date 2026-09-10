// A path an agent printed is clickable while the agent is still working.
//
// It was not. Nothing here is a link until Command is down, and the answer to "is this a real
// file" comes from the daemon, so the rows on screen are read as output arrives rather than when
// a link is asked for. That reading waited for the output to settle, and an agent redrawing its
// own screen never settles: the scan was starved for as long as the agent kept working. Measured
// on a real transcript, the last scan ran while the screen was still filling and none ran after.
//
// The first hover could not recover it either. xterm keeps what a link provider answered for a
// line and asks again only when the pointer moves to a different line, so the answer that arrived
// a moment later was never used, and the path stayed inert until the pointer left and came back.
import { openTerminal, evaluate, sleep, type, press, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'fixtures', 'agent-redraw.sh');
const target = '/tmp/tt-agent-path-probe.txt';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

await type(client, `touch ${target}; sh ${script} ${target}`);
await sleep(3000);

const onScreen = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));
r.ok('the agent has drawn its path', onScreen.includes(target), onScreen.slice(0, 80));

// No mouse yet. The rows on screen have to be read while the redraw is still going.
const resolved = String(
  await evaluate(
    client,
    `JSON.stringify(window.__tabterm.resolvedPaths().filter((p) => p.candidate === ${JSON.stringify(target)}))`,
  ),
);
r.ok(
  'and it is confirmed while the redraw is still running',
  resolved.includes('"exists":true'),
  resolved,
);

const geo = JSON.parse(await evaluate(client, `JSON.stringify(window.__tabterm.geometry())`));
const lines = onScreen.split('\n');
const row = lines.findIndex((l) => l.includes(target));
const base = lines.length - geo.rows;
const col = lines[row].indexOf(target) + 6;

const pointer = () => evaluate(client, `!!document.querySelector('.xterm-cursor-pointer')`);
const move = async (x) => {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(geo.left + x * geo.cellWidth),
    y: Math.round(geo.top + (row - base) * geo.cellHeight + geo.cellHeight / 2),
    modifiers: 4, // Meta, the modifier that makes a path a link
  });
  await sleep(140);
};

/**
 * One pass, the way a hand arrives. Not a second one, which is what used to be needed.
 *
 * Polled rather than read once: the program is still drawing, and xterm drops the link it is
 * holding whenever the row under it is rendered, then asks for it again.
 */
let lit = false;
for (const x of [col - 6, col - 4, col - 2, col]) await move(x);
for (let waited = 0; waited < 3000 && !lit; waited += 200) {
  lit = await pointer();
  if (!lit) await sleep(200);
}
r.ok('one pass of the pointer is enough to light it up', lit, 'no pointer');

await press(client, 'c', 'KeyC', 2, 67); // Ctrl+C, so the redraw does not outlive the check
await sleep(400);
await finish();
r.done();
