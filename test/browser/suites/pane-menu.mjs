// The right-click menu on a pane.
//
// Every check here is a thing that was reported as broken by hand: the menu ran off the screen
// near an edge, Select all appeared to do nothing, and Clear only unselected the text.
import {
  openTerminal,
  evaluate,
  readScreen,
  sleep,
  type,
  finish,
  realClick,
  openPaneMenu,
  waitFor,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo MENU-SUITE-LINE\r');
await sleep(1200);

const openMenu = (x, y) => openPaneMenu(client, x, y);
// Pressed and released, not `.click()`: the difference is what made every entry dead to a
// real mouse while every test passed.
const choose = (label) => realClick(client, '.term-menu-item', label);

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
/**
 * Detach is greyed for a lone pane. **Close is not.**
 *
 * There is nowhere to detach a pane to when it is the only one, so that entry says so. Closing
 * is different: somebody who closes the only terminal in a tab means to be rid of the tab, and
 * greying it out was answering a question nobody asked.
 */
r.ok(
  'moving a lone pane to its own tab is greyed, since there is nowhere to move it',
  disabled.includes('Move to its own tab'),
  disabled.join(' | '),
);
r.ok(
  'but closing it is offered, and means closing the tab',
  !disabled.includes('Close session'),
  disabled.join(' | '),
);
r.ok(
  'and the menu is grouped rather than one long list',
  Number(await evaluate(client, "document.querySelectorAll('.term-menu-rule').length")) >= 4,
);
r.ok('with settings reachable from the terminal', items.includes('Settings'), items.join(' | '));

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

// The corner is where the menu used to open mostly off screen. Aimed at the terminal's own
// corner rather than the window's, since a right click outside the terminal opens no menu.
const view = JSON.parse(await evaluate(client, `JSON.stringify({w: innerWidth, h: innerHeight})`));
const corner = JSON.parse(
  await evaluate(
    client,
    `(() => { const b = document.querySelector('.xterm').getBoundingClientRect();
       return JSON.stringify({ x: Math.round(b.right - 6), y: Math.round(b.bottom - 6) }); })()`,
  ),
);
await openMenu(corner.x, corner.y);
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

await finish();
r.done();
