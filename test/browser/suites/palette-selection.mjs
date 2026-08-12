// Selecting and acting are separate steps.
//
// Arrow keys or a click move the highlight and nothing else. Enter pastes what is highlighted,
// Command+Enter copies it. The point is being able to look at a command before choosing it: a
// list that pastes into a live terminal the instant you click gives you no chance to.
import {
  openTerminal,
  openPalette,
  pressInPalette,
  evaluate,
  sleep,
  readScreen,
  type,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

// Give history something to find, so the list has rows that are text rather than actions.
for (const command of ['echo palette-alpha', 'echo palette-beta', 'echo palette-gamma']) {
  await type(client, command);
  await sleep(700);
}

await openPalette(client);
await sleep(900);

const rows = () =>
  evaluate(
    client,
    `JSON.stringify({
      count: document.querySelectorAll('.palette-row').length,
      selected: [...document.querySelectorAll('.palette-row')].findIndex(x => x.classList.contains('selected')),
      selectedText: document.querySelector('.palette-row.selected .palette-command')?.textContent ?? null,
    })`,
  ).then((s) => JSON.parse(s));

const start = await rows();
r.ok(
  'the list appears with a row already selected',
  start.count > 1 && start.selected === 0,
  `${String(start.count)} rows`,
);

await pressInPalette(client, 'ArrowDown', 'ArrowDown', 0, 40);
await sleep(250);
r.ok('ArrowDown moves the selection', (await rows()).selected === 1);

await pressInPalette(client, 'ArrowUp', 'ArrowUp', 0, 38);
await sleep(250);
r.ok('ArrowUp moves it back', (await rows()).selected === 0);

await pressInPalette(client, 'End', 'End', 0, 35);
await sleep(250);
const end = await rows();
r.ok('End jumps to the last row', end.selected === end.count - 1);

await pressInPalette(client, 'Home', 'Home', 0, 36);
await sleep(250);
r.ok('Home jumps back to the first', (await rows()).selected === 0);

// A click selects and does nothing else. This is the behavior being asserted.
//
// A history row specifically: actions lead the list, and Enter on an action runs it rather than
// pasting, which is correct but is not what this is checking.
const HISTORY_ROW = '.palette-row:not(.is-action):not(.is-saved):not(.is-merge)';
const historyIndex = await evaluate(
  client,
  `[...document.querySelectorAll('.palette-row')].findIndex(x => x.matches(${JSON.stringify(HISTORY_ROW)}))`,
);
r.ok(
  'the list contains history rows as well as actions',
  historyIndex > 0,
  `first at ${String(historyIndex)}`,
);

const screenBefore = await readScreen(client);
await evaluate(
  client,
  `document.querySelectorAll('.palette-row')[${String(historyIndex)}]?.click()`,
);
await sleep(600);

const clicked = await rows();
r.ok(
  'clicking a row selects it',
  clicked.selected === historyIndex,
  `index ${String(clicked.selected)}`,
);
r.ok(
  'and does not paste anything',
  (await readScreen(client)) === screenBefore,
  'terminal unchanged',
);
r.ok(
  'the palette stays open after a click',
  (await evaluate(client, `!document.querySelector('.palette').hidden`)) === true,
);

// Command+Enter copies rather than pasting.
const chosen = clicked.selectedText;
await evaluate(client, `navigator.clipboard.writeText('CLIPBOARD-BEFORE')`);
await pressInPalette(client, 'Enter', 'Enter', 4, 13);
await sleep(900);

const clipboard = await evaluate(client, `navigator.clipboard.readText()`);
r.ok(
  'Command+Enter copies the selected row',
  clipboard === chosen,
  JSON.stringify(String(clipboard).slice(0, 40)),
);
r.ok(
  'and pastes nothing into the terminal',
  (await readScreen(client)) === screenBefore,
  'terminal unchanged',
);

// Enter pastes it.
await openPalette(client);
await sleep(900);
await evaluate(
  client,
  `document.querySelectorAll('.palette-row')[${String(historyIndex)}]?.click()`,
);
await sleep(400);
const second = await rows();
await pressInPalette(client, 'Enter', 'Enter', 0, 13);
await sleep(1000);

r.ok(
  'Enter closes the palette',
  (await evaluate(client, `document.querySelector('.palette').hidden`)) === true,
);

const after = await readScreen(client);
const lastLine = after.split('\n').filter(Boolean).pop() ?? '';
r.ok(
  'Enter pastes the row that was selected',
  lastLine.includes(second.selectedText ?? '\u0000'),
  lastLine,
);
r.ok(
  'and does not run it',
  !after.split('\n').some((line) => line.trim() === second.selectedText),
  'no output line for it',
);

r.done();
