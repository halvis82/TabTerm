// The right-click menu on a pane.
//
// Every check here is a thing that was reported as broken by hand: the menu ran off the screen
// near an edge, Select all appeared to do nothing, and Clear only unselected the text.
import { openTerminal, evaluate, readScreen, sleep, type, finish } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await sleep(4500);
await type(client, 'echo MENU-SUITE-LINE\r');
await sleep(1200);

const openMenu = async (x, y) => {
  await evaluate(
    client,
    `document.querySelector('.xterm-screen').dispatchEvent(
       new MouseEvent('contextmenu', { clientX: ${String(x)}, clientY: ${String(y)}, bubbles: true }))`,
  );
  await sleep(250);
};
const choose = async (label) =>
  evaluate(
    client,
    `[...document.querySelectorAll('.term-menu-item')].find(b => b.textContent === ${JSON.stringify(label)})?.click()`,
  );

await openMenu(60, 60);
const items = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map(b => b.textContent))`,
  ),
);
r.ok('the menu offers the pane actions', items.includes('Kill session'), items.join(' | '));
r.ok('and offers moving a pane to its own tab', items.includes('Move to its own tab'));

// A lone pane cannot be closed or detached, and says so rather than doing nothing.
const disabled = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.term-menu-item')].filter(b => b.disabled).map(b => b.textContent))`,
  ),
);
r.ok(
  'close and detach are greyed for a lone pane',
  disabled.includes('Close pane'),
  disabled.join(' | '),
);

await choose('Select all');
await sleep(500);
const selected = String(await evaluate(client, `window.__tabterm.selection()`));
r.ok(
  'Select all really selects',
  selected.includes('MENU-SUITE-LINE'),
  `${String(selected.length)} chars`,
);

await openMenu(60, 60);
await choose('Clear');
await sleep(1000);
const screen = await readScreen(client);
r.ok('Clear really clears', !screen.includes('MENU-SUITE-LINE'));
r.ok(
  'and offers to undo it',
  await evaluate(client, `!!document.querySelector('#clear-undo:not([hidden])')`),
);

// The corner is where the menu used to open mostly off screen.
const view = JSON.parse(await evaluate(client, `JSON.stringify({w: innerWidth, h: innerHeight})`));
await openMenu(view.w - 6, view.h - 6);
const rect = JSON.parse(
  await evaluate(
    client,
    `(() => { const m = document.querySelector('.term-menu').getBoundingClientRect();
       return JSON.stringify({ r: Math.round(m.right), b: Math.round(m.bottom), l: Math.round(m.left), t: Math.round(m.top) }); })()`,
  ),
);
r.ok(
  'right-clicking the bottom corner keeps the whole menu on screen',
  rect.r <= view.w && rect.b <= view.h && rect.l >= 0 && rect.t >= 0,
  JSON.stringify(rect),
);

await finish(client);
r.done();
