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
 * And the menu says so rather than either running it or hiding it.
 *
 * "i didn't mean hide them from this menu, in that menu you should just color them or fade them
 * out kinda to be disabled. for any action that is not available from the current screen." A list
 * whose contents change with the state of the page is a list nobody can learn.
 */
const state = async () =>
  JSON.parse(
    String(
      await evaluate(
        client,
        `JSON.stringify(Object.fromEntries(window.__tabterm.actions().map((a) => [a.id, a.enabled])))`,
      ),
    ),
  );
const onStartScreen = await state();
r.ok(
  'the menu still lists splitting from the start screen',
  'split-right' in onStartScreen && 'split-down' in onStartScreen,
  JSON.stringify(Object.keys(onStartScreen)),
);
r.ok(
  'and marks it unavailable rather than letting it run',
  onStartScreen['split-right'] === false && onStartScreen['split-down'] === false,
  JSON.stringify(onStartScreen),
);
r.ok(
  'while what a tab can always do stays available',
  onStartScreen['new-terminal'] === true && onStartScreen['agent-tab'] === true,
  JSON.stringify(onStartScreen),
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

const onAPane = await state();
r.ok(
  'and the menu makes it available again once there is a pane to act on',
  onAPane['split-right'] === true && onAPane['split-down'] === true,
  JSON.stringify(onAPane),
);

/**
 * And the menu says what is possible **now**, without being closed and opened again.
 *
 * Reported as: "it should update automatically when something changes on the site. i typed a
 * command here and i have to exit the menu and reopen for it to update to include the new
 * options." The list is built when the menu opens, and leaving the start screen is exactly when
 * four more things become possible.
 */
{
  const fresh = await openTerminal();
  await waitFor(fresh.client, "document.querySelector('.launcher-input')");
  await sleep(500);
  await evaluate(fresh.client, `document.getElementById('cmd-button')?.click()`);
  await waitFor(fresh.client, `document.querySelector('.cmd-panel')?.hidden === false`, 8000);
  await evaluate(
    fresh.client,
    `[...document.querySelectorAll('.cmd-tab')].find((t) => t.textContent === 'Actions')?.click()`,
  );
  await sleep(500);
  const faded = () =>
    evaluate(
      fresh.client,
      `[...document.querySelectorAll('.cmd-panel:not([hidden]) .cmd-row.is-action')]
         .filter((row) => row.classList.contains('is-disabled')).length`,
    );
  r.ok(
    'the open menu shows unavailable actions on the start screen',
    Number(await faded()) > 0,
    String(await faded()),
  );

  // Typed with the menu left open, which is the whole of the report.
  await type(fresh.client, 'echo menu-should-update\r');
  /*
   * The start screen going is what makes the actions possible, and on a loaded machine that can
   * take longer than the typing does. Waited for separately, so a slow machine is not reported
   * as the menu failing to keep up.
   */
  await waitUntil(
    async () =>
      (await evaluate(fresh.client, `document.querySelector('.launcher')?.hidden === false`)) !==
      true,
    30000,
  );
  const updated = await waitUntil(async () => Number(await faded()) === 0, 20000);
  r.ok(
    'and stops saying so the moment a terminal is there, without being reopened',
    updated,
    `${String(await faded())} still faded`,
  );
  r.ok(
    'with the menu still open',
    (await evaluate(fresh.client, `document.querySelector('.cmd-panel')?.hidden === false`)) ===
      true,
  );
}

await finish();
r.done();
