// The things you do to a pane need a pane, and the start screen is not one.
//
// Reported with a photograph: Command Shift S on the start screen split the tab in two, and the
// start screen ended up squeezed into the strip at the bottom with the folder box inside it.
// "we should not allow such actions from homescreen, only in established terminals."
//
// And the other half of the same report, which is the part that makes this hard: "we do need to
// allow it in actual open terminals that have no output though. for example when we have a
// terminal in ~/ and we run 'ls' then 'clear' it looks like an empty terminal. but we cannot
// misclassify and think that's the homescreen and block such functions."
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  press,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(600);

const panes = () => evaluate(client, 'window.__tabterm.paneIds().length');
const showing = () => evaluate(client, `document.querySelector('.launcher')?.hidden === false`);

r.ok('the start screen is up', (await showing()) === true);
r.ok('with one pane behind it', Number(await panes()) === 1, String(await panes()));

// Shift+Command+S, which is the shipped default for splitting right.
await press(client, 's', 'KeyS', 12, 83);
await sleep(1200);
r.ok(
  'splitting does nothing while the start screen is up',
  Number(await panes()) === 1,
  String(await panes()),
);
r.ok('and the start screen is still the start screen', (await showing()) === true);

// Shift+Command+K, clear, which has nothing to clear, and Control+Command+W, close.
await press(client, 'k', 'KeyK', 12, 75);
await press(client, 'w', 'KeyW', 6, 87);
await sleep(800);
r.ok(
  'nor does clearing or closing a pane that is not there',
  Number(await panes()) === 1 && (await showing()) === true,
  `${String(await panes())} panes`,
);

/*
 * And the menu does not offer what it cannot do.
 *
 * The keyboard is one way in and the palette is another, and an entry that is offered and does
 * nothing is the fault this list already declines elsewhere: "flush this out for all such
 * interfaces to ensure expected behavior".
 */
const offered = String(
  await evaluate(client, `JSON.stringify(window.__tabterm.actions().map((a) => a.id))`),
);
r.ok(
  'and the menu does not offer splitting from the start screen either',
  !offered.includes('split-right') && !offered.includes('split-down'),
  offered,
);

/**
 * And a real terminal with nothing on it is still a real terminal.
 *
 * This is the half that a check on "does the screen look empty" would get wrong, and it is the
 * one he named when reporting it.
 */
await type(client, 'ls\r');
await waitUntil(
  async () => String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).length > 10,
  20000,
);
await type(client, 'clear\r');
await sleep(1200);
r.ok('the start screen has gone', (await showing()) !== true);

await press(client, 's', 'KeyS', 12, 83);
const split = await waitUntil(async () => Number(await panes()) === 2, 20000);
r.ok(
  'and a cleared terminal can still be split, which is the half that must not be broken',
  split,
  `${String(await panes())} panes`,
);

const offeredNow = String(
  await evaluate(client, `JSON.stringify(window.__tabterm.actions().map((a) => a.id))`),
);
r.ok(
  'and the menu offers it again once there is a pane to act on',
  offeredNow.includes('split-right') && offeredNow.includes('split-down'),
  offeredNow,
);

await finish();
r.done();
