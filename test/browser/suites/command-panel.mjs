// The command panel: tabs, selection, double-click, dragging, minimizing.
//
// Selection and action are separate steps everywhere in this product, and this is the surface
// where that matters most: the list sits over a live terminal, and a click that pasted would
// mean you could never read a command before choosing it.
import { openTerminal, evaluate, readScreen, sleep, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

// Give Recent something to hold.
const TAG = String(Date.now()).slice(-5);
for (const command of [`echo panel-${TAG}-one`, `echo panel-${TAG}-two`]) {
  await type(client, command);
  await sleep(700);
}

r.ok(
  'a button sits in the top right',
  (await evaluate(client, `!!document.getElementById('cmd-button')`)) === true,
);

await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await sleep(800);

r.ok(
  'clicking it opens the panel',
  (await evaluate(client, `!document.querySelector('.cmd-panel').hidden`)) === true,
);
r.ok(
  'with a tab for each kind of thing it holds',
  (await evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.cmd-tab')].map(t => t.textContent))`,
  )) === JSON.stringify(['Favorites', 'Recent', 'Actions', 'Stats']),
);
r.ok(
  'and it is translucent, so output behind it stays readable',
  (await evaluate(
    client,
    `getComputedStyle(document.querySelector('.cmd-panel')).backgroundColor.startsWith('rgba')`,
  )) === true,
);

// Recent tab.
await evaluate(
  client,
  `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Recent')?.click()`,
);
await sleep(600);

const rows = () =>
  evaluate(
    client,
    `JSON.stringify({
      count: document.querySelectorAll('.cmd-row').length,
      selected: [...document.querySelectorAll('.cmd-row')].findIndex(x => x.classList.contains('selected')),
      text: document.querySelector('.cmd-row.selected .cmd-row-label')?.textContent ?? null,
    })`,
  ).then((s) => JSON.parse(s));

const listed = await rows();
r.ok('Recent lists commands that were run', listed.count > 0, `${String(listed.count)} rows`);

// Clicking selects and does nothing else.
const before = await readScreen(client);
await evaluate(client, `document.querySelectorAll('.cmd-row')[1]?.click()`);
await sleep(400);
const clicked = await rows();
r.ok('a single click selects', clicked.selected === 1, `index ${String(clicked.selected)}`);
r.ok('and pastes nothing', (await readScreen(client)) === before);
r.ok(
  'the panel stays open',
  (await evaluate(client, `!document.querySelector('.cmd-panel').hidden`)) === true,
);
r.ok(
  'the footer names what the keys do for that row',
  String(await evaluate(client, `document.querySelector('.cmd-hints')?.textContent`)).includes(
    'Double-click',
  ),
  String(await evaluate(client, `document.querySelector('.cmd-hints')?.textContent`)),
);

// Double-click pastes without touching the clipboard.
await evaluate(client, `navigator.clipboard.writeText('CLIP-UNTOUCHED')`);
const chosen = clicked.text;
await evaluate(
  client,
  `(() => {
    const row = document.querySelectorAll('.cmd-row')[1];
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`,
);
await sleep(900);

const line = (await readScreen(client)).split('\n').filter(Boolean).pop() ?? '';
r.ok('double-click pastes the command', line.includes(chosen ?? ' '), line);
r.ok(
  'and leaves the clipboard alone',
  (await evaluate(client, `navigator.clipboard.readText()`)) === 'CLIP-UNTOUCHED',
);
// Pasted, not run: the command sits on the prompt line and nowhere else. Checking for the
// tagged echo instead would find the run that seeded history at the top of this suite.
const linesAfter = (await readScreen(client)).split('\n').filter(Boolean);
r.ok(
  'and does not run it',
  !linesAfter.some((each) => each.trim() === (chosen ?? '')),
  linesAfter.slice(-1)[0] ?? '',
);

// Dragging, and remembering where it was put. Reopen only if the paste closed it, rather than
// toggling blindly: clicking the button when it is already open closes it, and then the
// measurements below are of a hidden element.
await evaluate(
  client,
  `(() => { if (document.querySelector('.cmd-panel').hidden) document.getElementById('cmd-button')?.click(); })()`,
);
await sleep(700);
const start = JSON.parse(
  await evaluate(
    client,
    `(() => { const b = document.querySelector('.cmd-panel').getBoundingClientRect();
       return JSON.stringify({ x: Math.round(b.left), y: Math.round(b.top) }); })()`,
  ),
);
// Up and to the left. The panel opens anchored to the top right, so dragging down or right is
// pinned by the clamp that keeps it on screen, and in a small window that is no movement at all.
// A test that cannot tell "clamped correctly" from "drag is broken" is testing the window size.
await evaluate(
  client,
  `(() => {
    const header = document.querySelector('.cmd-header');
    const opts = { bubbles: true, clientX: 200, clientY: 200, pointerId: 1 };
    header.dispatchEvent(new PointerEvent('pointerdown', opts));
    header.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: 120, clientY: 150 }));
    header.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: 120, clientY: 150 }));
  })()`,
);
await sleep(500);
const moved = JSON.parse(
  await evaluate(
    client,
    `(() => { const b = document.querySelector('.cmd-panel').getBoundingClientRect();
       return JSON.stringify({ x: Math.round(b.left), y: Math.round(b.top) }); })()`,
  ),
);
r.ok(
  'the panel can be dragged',
  moved.x !== start.x || moved.y !== start.y,
  `${String(start.x)},${String(start.y)} -> ${String(moved.x)},${String(moved.y)}`,
);

const stored = await evaluate(
  client,
  `(async () => JSON.stringify((await chrome.storage.local.get('tabterm.panel'))['tabterm.panel'] ?? null))()`,
);
r.ok('and where it was put is remembered', String(stored).includes('"x"'), String(stored));

// Minimizing.
await evaluate(client, `document.querySelector('.cmd-header .cmd-icon')?.click()`);
await sleep(500);
r.ok(
  'it minimizes to a puck',
  (await evaluate(
    client,
    `document.querySelector('.cmd-panel').hidden && !document.querySelector('.cmd-puck').hidden`,
  )) === true,
);
await evaluate(client, `document.querySelector('.cmd-puck')?.click()`);
await sleep(500);
r.ok(
  'and the puck brings it back',
  (await evaluate(client, `!document.querySelector('.cmd-panel').hidden`)) === true,
);

// Settings.
await evaluate(client, `document.querySelector('.cmd-gear')?.click()`);
await sleep(500);
r.ok(
  'the gear opens settings with a theme choice',
  (await evaluate(client, `!!document.querySelector('.cmd-settings select')`)) === true,
);
r.ok(
  'and lists the shortcuts the page itself owns',
  Number(await evaluate(client, `document.querySelectorAll('.cmd-key-row').length`)) > 3,
);

r.done();
