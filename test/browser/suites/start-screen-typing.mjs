// The box under the start screen grows to fit a long line, and then gets out of the way.
//
// Reported repeatedly as a mess: the prompt drawn three times over with nothing submitted, and
// `>....` after it. Both are one shell doing something reasonable in a terminal three rows tall.
// zsh does not wrap a line that cannot fit: it truncates the display and marks it. So there were
// no wrapped rows to count, the box never grew, and the two earlier attempts to measure this from
// the screen could not have worked. The line is counted from the keystrokes now.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await waitFor(client, `(window.__tabterm.readViewport() ?? '').trim().length > 0`, 20000);
await sleep(800);

const state = async () =>
  JSON.parse(
    await evaluate(
      client,
      `JSON.stringify({
         rows: window.__tabterm.geometry()?.rows ?? 0,
         launcher: document.querySelectorAll('.launcher-input').length,
         prompts: (window.__tabterm.readScreen() ?? '').split('\\n').filter((l) => l.includes('~ %')).length,
         truncated: (window.__tabterm.readViewport() ?? '').includes('>....'),
       })`,
    ),
  );

const start = await state();
r.ok(
  'the terminal starts as a strip under the start screen',
  start.rows <= 4,
  JSON.stringify(start),
);

// Enough to need a few rows, not enough to give up the start screen.
await type(client, 'f'.repeat(240), { submit: false });
await sleep(700);
const grown = await state();
r.ok(
  'it grows to fit the line being typed',
  grown.rows > start.rows && grown.launcher === 1,
  JSON.stringify(grown),
);
r.ok(
  'the prompt is still drawn once, not once per size it has been',
  grown.prompts === 1,
  JSON.stringify(grown),
);
r.ok(
  'and the shell is not truncating what is being typed',
  grown.truncated === false,
  JSON.stringify(grown),
);

// Past what a strip can show, which is where it stops being one.
await type(client, 'f'.repeat(700), { submit: false });
await sleep(1200);
const handed = await state();
r.ok(
  'past what it can show, the start screen gets out of the way',
  handed.launcher === 0 && handed.rows > grown.rows,
  JSON.stringify(handed),
);
r.ok(
  'and the whole line is on screen rather than truncated',
  handed.truncated === false && handed.prompts === 1,
  JSON.stringify(handed),
);

// What was typed is still there: this is a change of view, not a fresh terminal.
const screen = String(await evaluate(client, `window.__tabterm.readScreen()`));
r.ok(
  'with what was typed still on the line',
  (screen.match(/f/g) ?? []).length > 900,
  `${String((screen.match(/f/g) ?? []).length)} characters still there`,
);

await finish();
r.done();
