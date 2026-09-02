// Picking text out by hand, and the color picker that every color now comes from.
import {
  openTerminal,
  evaluate,
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
// Its own slate. Highlights are kept per session and a previous run's are still there.
await evaluate(
  client,
  `new Promise((done) => chrome.storage.local.remove(['tabterm.highlights', 'tabterm.recentColors'], () => done('')))`,
);
await type(client, 'echo pick-me-out\r');
await sleep(1500);

// Select the line the way a person does, by dragging across it.
const g = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())'));
// Found rather than hardcoded: output can land a line lower than expected, and a fixed row was
// the cause of two wrong diagnoses in earlier suites.
const target = String(await evaluate(client, 'window.__tabterm.readScreen()'))
  .split(String.fromCharCode(10))
  .findIndex((l) => l.trim() === 'pick-me-out');
const y = g.top + g.cellHeight * (target + 0.5);
const box = { x: g.left, y: g.top };

const drag = async (x1, x2) => {
  const send = async (type, x, button = 'left', clickCount = 1) =>
    client.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      clickCount,
      buttons: type === 'mouseMoved' ? 1 : 0,
    });
  await send('mousePressed', x1);
  await send('mouseMoved', (x1 + x2) / 2);
  await send('mouseMoved', x2);
  await send('mouseReleased', x2);
};
await drag(box.x + 2, box.x + 130);
await sleep(400);
r.ok(
  'a drag selects the text',
  String(await evaluate(client, 'window.__tabterm.selection()')).includes('pick-me-out'),
);

await openPaneMenu(client, box.x + 60, y);
await sleep(250);
r.ok(
  'the menu offers a highlight',
  await evaluate(client, "!!document.querySelector('.term-menu-swatch')"),
);
r.ok(
  'with its color beside it rather than behind another menu',
  JSON.parse(
    await evaluate(
      client,
      `(() => { const row = document.querySelector('.term-menu-row');
        const b = row.querySelector('.term-menu-item').getBoundingClientRect();
        const s = row.querySelector('.term-menu-swatch').getBoundingClientRect();
        return JSON.stringify(s.left >= b.right - 1); })()`,
    ),
  ),
);

// The swatch, and only the swatch, opens the picker.
await realClick(client, '.term-menu-swatch');
await sleep(300);
r.ok(
  'pressing the color opens the picker',
  await evaluate(client, "!!document.querySelector('.color-picker-map')"),
);
r.ok(
  'and it opens beside the swatch rather than over it',
  JSON.parse(
    await evaluate(
      client,
      `(() => { const p = document.querySelector('.color-picker').getBoundingClientRect();
        const s = document.querySelector('.term-menu-swatch').getBoundingClientRect();
        return JSON.stringify(p.left >= s.right - 2 || p.right <= s.left + 2); })()`,
    ),
  ),
);
r.ok(
  'the last few colors are offered as well as the map',
  Number(await evaluate(client, "document.querySelectorAll('.color-picker-swatch').length")) >= 1,
);

// Click into the map. Anywhere on it is a color, which is the whole point.
const map = JSON.parse(
  await evaluate(
    client,
    `(() => { const m = document.querySelector('.color-picker-map').getBoundingClientRect();
      return JSON.stringify({ x: m.left + m.width * 0.12, y: m.top + m.height * 0.3 }); })()`,
  ),
);
for (const type of ['mousePressed', 'mouseReleased']) {
  await client.send('Input.dispatchMouseEvent', {
    type,
    x: map.x,
    y: map.y,
    button: 'left',
    clickCount: 1,
  });
}
await sleep(700);

// Asked of the controller rather than of the DOM: the WebGL renderer paints a decoration on a
// canvas, so there is no element to measure, exactly as with a selection.
const drawn = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.highlights())'));
r.ok('picking a color highlights the text', drawn.length > 0, JSON.stringify(drawn));
r.ok(
  'in the color that was picked, not the default',
  drawn[0]?.color !== undefined && drawn[0].color !== '#ffd54a',
  JSON.stringify(drawn[0]),
);
r.ok(
  'the picker closes once it has been used',
  !(await evaluate(client, "!!document.querySelector('.color-picker-map')")),
);

const pips = Number(await evaluate(client, "document.querySelectorAll('.marker-pip').length"));
r.ok('the highlight appears on the rail beside the scrollbar', pips > 0, String(pips));

// It is remembered, and offered first next time.
const stored = JSON.parse(
  await evaluate(
    client,
    `new Promise((done) => chrome.storage.local.get('tabterm.highlights', (v) =>
      done(JSON.stringify(Object.values(v['tabterm.highlights'] ?? {}).flat()))))`,
  ),
);
r.ok('and is written down, so it survives a reload', stored.length > 0, JSON.stringify(stored));
r.ok(
  'anchored by its text and which occurrence of it, counted from the start',
  typeof stored[0]?.text === 'string' && typeof stored[0]?.occurrence === 'number',
  JSON.stringify(stored[0]),
);

const recents = JSON.parse(
  await evaluate(
    client,
    `new Promise((done) => chrome.storage.local.get('tabterm.recentColors', (v) =>
      done(JSON.stringify(v['tabterm.recentColors'] ?? {}))))`,
  ),
);
r.ok(
  'the color is remembered for next time',
  (recents.highlight ?? []).length > 0,
  JSON.stringify(recents),
);
r.ok(
  'and kept apart from the colors used for titles and markers',
  !('title' in recents) || recents.title.join() !== (recents.highlight ?? []).join(),
);

/**
 * It stays where it was put.
 *
 * Both reported symptoms were one mistake: the position was recomputed from the text on every
 * redraw, and the anchor counted occurrences from the **end** of the buffer. A shell prints its
 * prompt again after every command, so each new copy became the last occurrence and the
 * highlight moved onto it. It is now pinned to a marker on its own line and never recomputed.
 */
const before = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.highlights())'));
await type(client, 'echo pick-me-out\r');
await sleep(1600);
await type(client, 'echo pick-me-out\r');
await sleep(1600);
const after = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.highlights())'));
r.ok(
  'printing the same text again does not move the highlight',
  after.length === before.length,
  JSON.stringify(after),
);

const rail = Number(await evaluate(client, "document.querySelectorAll('.marker-pip').length"));
r.ok('and does not add a second one on the rail', rail === 1, String(rail));

// Only text that was actually printed. A terminal line is a fixed grid, so a drag to the right
// edge selects blank cells as readily as characters, and a colored band over nothing is not a
// highlight of anything.
const grid = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())'));
const blankRow = grid.top + grid.cellHeight * (grid.rows - 3.5);
for (const [kind, x] of [
  ['mousePressed', grid.left + grid.cellWidth * 4],
  ['mouseMoved', grid.left + grid.cellWidth * 40],
  ['mouseReleased', grid.left + grid.cellWidth * 40],
]) {
  await client.send('Input.dispatchMouseEvent', {
    type: kind,
    x,
    y: blankRow,
    button: 'left',
    clickCount: 1,
    buttons: kind === 'mouseMoved' ? 1 : 0,
  });
}
await sleep(300);
const wasCount = JSON.parse(
  await evaluate(client, 'JSON.stringify(window.__tabterm.highlights())'),
).length;
await openPaneMenu(client, grid.left + grid.cellWidth * 10, blankRow);
await sleep(250);
const offered = await evaluate(
  client,
  `(() => { const b = [...document.querySelectorAll('.term-menu-item')].find((x) => x.textContent === 'Highlight'); return b ? String(b.disabled) : 'missing'; })()`,
);
r.ok(
  'highlighting empty space is not offered',
  offered === 'true' || offered === true,
  String(offered),
);
await evaluate(client, "document.querySelector('.term-menu')?.remove()");
const stillCount = JSON.parse(
  await evaluate(client, 'JSON.stringify(window.__tabterm.highlights())'),
).length;
r.ok(
  'and nothing was added',
  stillCount === wasCount,
  `${String(wasCount)} -> ${String(stillCount)}`,
);

/**
 * Overlapping highlights merge rather than stacking.
 *
 * Highlighting "sen", then "ce sent", then "nice senten" used to leave three translucent layers
 * piled on the overlap, each darker than the last. The colors were stacking because the ranges
 * were not.
 */
await type(client, 'echo this is a nice sentence\r');
await sleep(1600);
const sentence = String(await evaluate(client, 'window.__tabterm.readScreen()'))
  .split(String.fromCharCode(10))
  .findIndex((l) => l.trim() === 'this is a nice sentence');

const cells = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())'));
const select = async (fromCol, toCol) => {
  const y = cells.top + cells.cellHeight * (sentence + 0.5);
  const at = (col) => cells.left + cells.cellWidth * col;
  for (const [kind, col, buttons] of [
    ['mousePressed', fromCol, 0],
    ['mouseMoved', toCol, 1],
    ['mouseReleased', toCol, 0],
  ]) {
    await client.send('Input.dispatchMouseEvent', {
      type: kind,
      x: at(col),
      y,
      button: 'left',
      clickCount: 1,
      buttons,
    });
  }
  await sleep(250);
};
const onSentence = async () => {
  const all = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.highlights())'));
  return all.filter((h) => 'this is a nice sentence'.includes(h.text));
};
const highlightNow = async () => {
  await openPaneMenu(
    client,
    cells.left + cells.cellWidth * 2,
    cells.top + cells.cellHeight * (sentence + 0.5),
  );
  await sleep(200);
  await realClick(client, '.term-menu-item', 'Highlight');
  await sleep(500);
};

// "sen" of "sentence".
await select(15, 18);
await highlightNow();
const one = await onSentence();
r.ok('a first highlight lands on the line', one.length === 1, JSON.stringify(one));

// Overlapping it, and wider on both sides.
await select(12, 21);
await highlightNow();
const merged = await onSentence();
r.ok(
  'an overlapping highlight merges rather than layering',
  merged.length === 1,
  JSON.stringify(merged),
);
r.ok(
  'and the merged one covers the wider span',
  (merged[0]?.text.length ?? 0) > (one[0]?.text.length ?? 0),
  JSON.stringify(merged[0]),
);

// Exactly what is there, which is how it comes off.
await select(12, 21);
await highlightNow();
r.ok('highlighting exactly what is highlighted removes it', (await onSentence()).length === 0);

// Put one back, then take it off from the menu.
await select(12, 21);
await highlightNow();
r.ok('and it can be put back', (await onSentence()).length === 1);

await openPaneMenu(
  client,
  cells.left + cells.cellWidth * 15,
  cells.top + cells.cellHeight * (sentence + 0.5),
);
await sleep(250);
const removeOffered = await evaluate(
  client,
  `[...document.querySelectorAll('.term-menu-item')].some((b) => b.textContent === 'Remove highlight')`,
);
r.ok(
  'right-clicking a highlight offers to remove it',
  removeOffered === true || removeOffered === 'true',
);
await realClick(client, '.term-menu-item', 'Remove highlight');
await sleep(500);
r.ok('and it goes', (await onSentence()).length === 0);

// Not offered where there is no highlight.
await openPaneMenu(
  client,
  cells.left + cells.cellWidth * 2,
  cells.top + cells.cellHeight * (sentence + 0.5),
);
await sleep(250);
const offeredOnPlain = await evaluate(
  client,
  `[...document.querySelectorAll('.term-menu-item')].some((b) => b.textContent === 'Remove highlight')`,
);
r.ok(
  'and is not offered where there is none',
  offeredOnPlain === false || offeredOnPlain === 'false',
  String(offeredOnPlain),
);
await evaluate(client, "document.querySelector('.term-menu')?.remove()");

await finish();
r.done();
