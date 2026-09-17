// Escape closes a context menu, and the terminal underneath never hears about it.
//
// Escape is how a menu is dismissed everywhere. It is also the interrupt key of every agent CLI
// this product hosts. With a menu open and the keystroke reaching the pane underneath, pressing it
// to put the menu away stopped an agent mid-answer: "i just accidentally cut claude off because i
// pressed esc to close the right click menu but it didn't".
//
// What the session receives is read from the session rather than inferred. `cat -v` prints control
// characters as text, so an escape that arrives shows up as `^[` and one that does not, does not.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  press,
  openPaneMenu,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

const tab = await openTerminal();
await waitFor(tab.client, "document.querySelector('.launcher-input')");
await type(tab.client, 'cat -v\r');
await sleep(1200);

const screen = () => evaluate(tab.client, `window.__tabterm.readScreen() ?? ''`).then(String);
/** How many escapes the program has been handed, which is the number that must not change. */
const escapes = async () => (await screen()).split('^[').length - 1;
const menuIsOpen = () =>
  evaluate(tab.client, `document.querySelectorAll('.term-menu').length`).then(Number);

/*
 * The control first: with no menu open, Escape reaches the session.
 *
 * Without this the check below passes just as well on a terminal that receives nothing at all,
 * which would prove nothing about menus.
 */
await press(tab.client, 'Escape', 'Escape', 0, 27);
const arrives = await waitUntil(async () => (await escapes()) > 0, 8000);
r.ok('an escape typed at the session reaches it', arrives, (await screen()).slice(-60));

// Now the case that was reported. Counted rather than cleared: the program is still running and
// swallows anything typed at it, so tidying the screen would mean leaving it and coming back.
const before = await escapes();
await openPaneMenu(tab.client, 120, 140);
r.ok('a right click opens a menu', (await menuIsOpen()) === 1);

await press(tab.client, 'Escape', 'Escape', 0, 27);
await sleep(700);
r.ok('escape closes the menu', (await menuIsOpen()) === 0);

/*
 * And nothing arrived. An escape that is going to reach the program reaches it in milliseconds, so
 * this waits a moment first rather than reading the screen the instant the menu goes.
 */
await sleep(1200);
const after = await escapes();
r.ok(
  'and the session was never told about it',
  after === before,
  `${String(before)} escapes before, ${String(after)} after`,
);

/*
 * And leaving takes the menu with you. A menu is about a place on a page, and coming back to find
 * it still sitting there means the next click lands on an entry opened for something else.
 */
await openPaneMenu(tab.client, 120, 140);
r.ok('a menu can be opened again', (await menuIsOpen()) === 1);
const other = await openTerminal();
await waitFor(other.client, "document.querySelector('.launcher-input')");
await sleep(800);
const gone = await waitUntil(async () => (await menuIsOpen()) === 0, 8000);
r.ok('and going to another tab closes it', gone, `${String(await menuIsOpen())} left open`);

await finish();
r.done();
