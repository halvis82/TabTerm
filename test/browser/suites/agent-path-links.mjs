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
import { openTerminal, evaluate, sleep, type, press, ready, finish, waitFor } from '../helpers.mjs';
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

const marked = () => evaluate(client, `document.querySelectorAll('.xterm-decoration').length > 0`);
r.ok('it is marked while the pointer is on it', await marked(), 'nothing was marked');
// The underline and the text are one color. It used to be underlined in whatever the cell was.
const underline = String(
  await evaluate(
    client,
    `(() => {
      const d = [...document.querySelectorAll('.xterm-decoration')][0];
      return d ? d.style.borderBottom : '';
    })()`,
  ),
);
r.ok(
  'the underline is drawn in the link color',
  /rgb\(78, *161, *255\)|rgb\(255, *95, *95\)/.test(underline),
  underline,
);
r.ok(
  'and the mark is not a box',
  !(await evaluate(
    client,
    `[...document.querySelectorAll('.xterm-decoration')].some((d) => d.style.border && d.style.border !== 'none')`,
  )),
  'a border is still being drawn',
);

/*
 * And the one that was reported: Command pressed while the pointer is already there.
 *
 * xterm asks its link providers when the pointer moves to a different line and keeps that answer
 * until it moves again, so pressing Command afterwards changed nothing and you had to move away
 * and come back before it would light up.
 */
const at = async (modifiers) => {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(geo.left + col * geo.cellWidth),
    y: Math.round(geo.top + (row - base) * geo.cellHeight + geo.cellHeight / 2),
    modifiers,
  });
  await sleep(140);
};
// Off the line and back onto it with nothing held, so the pointer is already sitting on the path.
await client.send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: Math.round(geo.left + 2 * geo.cellWidth),
  y: Math.round(geo.top + geo.cellHeight / 2),
  modifiers: 0,
});
await sleep(300);
await at(0);
await at(0);
await sleep(500);
r.ok('nothing is marked before Command is held', !(await marked()), 'marked with no modifier');

await client.send('Input.dispatchKeyEvent', {
  type: 'rawKeyDown',
  key: 'Meta',
  code: 'MetaLeft',
  modifiers: 4,
  windowsVirtualKeyCode: 91,
});
let late = false;
for (let waited = 0; waited < 2500 && !late; waited += 200) {
  late = await marked();
  if (!late) await sleep(200);
}
r.ok('holding Command marks it without moving the pointer', late, 'still nothing marked');

await press(client, 'c', 'KeyC', 2, 67); // Ctrl+C, so the redraw does not outlive the check
await sleep(400);

/*
 * And again on a tab that was refreshed, which is the case that was actually broken.
 *
 * The rows on screen are read as soon as there is a screen, and on a restored tab that is before
 * the socket is open and before the pane has been bound to its session. The question went nowhere
 * and was remembered as asked, so every path on the first screen stayed pending for the life of
 * the page. A restored tab is what you are looking at most of the time, so nothing was clickable.
 */
await evaluate(client, 'location.reload()');
await sleep(1200);
await ready(client);
await waitFor(client, `window.__tabterm.readScreen().includes(${JSON.stringify(target)})`);
await sleep(1500);

const afterReload = String(
  await evaluate(
    client,
    `JSON.stringify(window.__tabterm.resolvedPaths().filter((p) => p.candidate === ${JSON.stringify(target)}))`,
  ),
);
r.ok(
  'a path already on screen when the tab is restored is confirmed too',
  afterReload.includes('"exists":true'),
  afterReload,
);

await finish();
r.done();
