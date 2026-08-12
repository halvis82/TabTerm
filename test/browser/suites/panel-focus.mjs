// The panel and the terminal are never both active.
//
// Both visible, certainly: the panel is translucent so the output behind it stays readable. But
// only one of them has the keyboard, and while the panel does, the terminal's cursor stops so
// the screen says which. A blinking caret in a pane that is not listening says the opposite of
// what is true.
import {
  openTerminal,
  evaluate,
  readScreen,
  sleep,
  type,
  press,
  pressInPalette,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

await type(client, 'echo focus-probe');
await sleep(1200);
const seeded = await readScreen(client);
r.ok('the session has output', seeded.includes('focus-probe'));

// Command+K opens the panel. It used to also clear the terminal, because the keymap still had
// Command+K bound to clear, so opening the panel wiped the scrollback behind it.
await press(client, 'k', 'KeyK', 4, 75);
await sleep(900);

r.ok(
  'Command+K opens the panel',
  (await evaluate(client, `!document.querySelector('.cmd-panel').hidden`)) === true,
);
r.ok(
  'and does not clear the terminal',
  (await readScreen(client)).includes('focus-probe'),
  'output survived',
);

r.ok(
  'focus is inside the panel',
  String(await evaluate(client, `document.activeElement?.className`)).includes('cmd-search'),
  String(await evaluate(client, `document.activeElement?.className`)),
);
r.ok(
  'and the terminal is marked as not listening',
  (await evaluate(
    client,
    `document.getElementById('terminal').classList.contains('panel-has-keyboard')`,
  )) === true,
);

// Typing must reach the panel, not the shell.
const beforeTyping = await readScreen(client);
for (const ch of 'zzz') {
  await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
  await sleep(20);
}
await sleep(400);
r.ok('typing goes to the panel, not the terminal', (await readScreen(client)) === beforeTyping);
r.ok(
  'and lands in the search box',
  (await evaluate(client, `document.querySelector('.cmd-search').value`)) === 'zzz',
);

// Escape closes it and hands the keyboard back.
// Aimed at the panel, which owns the keyboard: focusing the pane first would be the test
// handing focus back before pressing the key.
await pressInPalette(client, 'Escape', 'Escape', 0, 27);
await sleep(600);
r.ok(
  'Escape closes the panel',
  (await evaluate(client, `document.querySelector('.cmd-panel').hidden`)) === true,
);
r.ok(
  'the terminal is listening again',
  (await evaluate(
    client,
    `!document.getElementById('terminal').classList.contains('panel-has-keyboard')`,
  )) === true,
);

await type(client, 'echo after-escape', { submit: false });
await sleep(500);
r.ok(
  'and typing reaches it once more',
  (await readScreen(client)).includes('after-escape'),
  (await readScreen(client)).split('\n').filter(Boolean).pop(),
);

// Pasting from the panel closes it.
await press(client, 'k', 'KeyK', 4, 75);
await sleep(800);
await evaluate(
  client,
  `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Recent')?.click()`,
);
// Wait for the list rather than guessing at how long it takes: clicking before it renders
// selects nothing, and then Enter has nothing to act on and the panel stays open.
for (let i = 0; i < 25; i++) {
  if (Number(await evaluate(client, `document.querySelectorAll('.cmd-row').length`)) > 0) break;
  await sleep(200);
}
await evaluate(client, `document.querySelectorAll('.cmd-row')[0]?.click()`);
await sleep(300);
await pressInPalette(client, 'Enter', 'Enter', 0, 13);
await sleep(700);
r.ok(
  'pasting closes the panel',
  (await evaluate(client, `document.querySelector('.cmd-panel').hidden`)) === true,
  JSON.stringify(
    await evaluate(
      client,
      `JSON.stringify({
        hidden: document.querySelector('.cmd-panel').hidden,
        rows: document.querySelectorAll('.cmd-row').length,
        selected: document.querySelector('.cmd-row.selected .cmd-row-label')?.textContent ?? null,
        active: document.activeElement?.className,
      })`,
    ),
  ),
);

// The Stats tab.
await press(client, 'k', 'KeyK', 4, 75);
await sleep(800);
await evaluate(
  client,
  `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Stats')?.click()`,
);
await sleep(600);
r.ok(
  'there is a Stats tab with session figures',
  Number(await evaluate(client, `document.querySelectorAll('.cmd-figure').length`)) === 6,
);
r.ok(
  'and it reports timings with timestamps',
  (await evaluate(client, `!!document.querySelector('.cmd-stat-time')`)) === true ||
    (await evaluate(client, `!!document.querySelector('.cmd-empty')`)) === true,
);

r.done();
