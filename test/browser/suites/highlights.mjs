// Picking text out by hand, and the color picker that every color now comes from.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  realClick,
  openPaneMenu,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await sleep(4500);
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
  'anchored by its text rather than by a line number',
  typeof stored[0]?.text === 'string' && typeof stored[0]?.fromEnd === 'number',
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

await finish();
r.done();
