// A copy button beside a link while Command is held over it.
//
// Asked for: "when we hold cmd and hover over a url or path ... have a very dynamic copy button
// appear next to it very smooth looking and disappears if we let go of cmd ... and of course if
// you click that copy button it should go away smoothly."
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
const URL_TEXT = 'https://example.com/copy-check';
await type(client, `echo ${URL_TEXT}\r`);
await sleep(1500);

const geo = JSON.parse(await evaluate(client, `JSON.stringify(window.__tabterm.geometry())`));
const lines = (await evaluate(client, `window.__tabterm.readScreen()`)).split('\n');
const row = lines.findIndex((l) => l.trim() === URL_TEXT);
r.ok('the URL is on screen', row >= 0, `row ${String(row)}`);

const state = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.linkCopy())')));
const moveTo = async (x, y, meta) => {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
    modifiers: meta ? 4 : 0,
  });
  await sleep(120);
};
const hover = async (col, rowAt, meta = true) => {
  const y = geo.top + rowAt * geo.cellHeight;
  for (const step of [-2, -1, 0]) await moveTo(geo.left + (col + step) * geo.cellWidth, y, meta);
};
const shownWithin = async (ms, want = true) => {
  for (let waited = 0; waited < ms; waited += 100) {
    if ((await state()).shown === want) return true;
    await sleep(100);
  }
  return false;
};
const metaKey = (type_) =>
  client.send('Input.dispatchKeyEvent', {
    type: type_,
    key: 'Meta',
    code: 'MetaLeft',
    modifiers: type_ === 'keyUp' ? 0 : 4,
    windowsVirtualKeyCode: 91,
  });

// Park away, then hover the URL with Command held.
await hover(60, row + 6.5);
await metaKey('rawKeyDown');
await hover(8, row + 0.5);
r.ok(
  'holding Command over a URL shows a copy button',
  await shownWithin(3000),
  JSON.stringify(await state()),
);
r.ok('for that URL', (await state()).text === URL_TEXT, (await state()).text);

const box = JSON.parse(
  String(
    await evaluate(
      client,
      `JSON.stringify(document.querySelector('.link-copy').getBoundingClientRect())`,
    ),
  ),
);
const urlEnd = geo.left + URL_TEXT.length * geo.cellWidth;
r.ok(
  'beside the link, on its row',
  box.left >= urlEnd - geo.cellWidth &&
    Math.abs(box.top + box.height / 2 - (geo.top + (row + 0.5) * geo.cellHeight)) < geo.cellHeight,
  JSON.stringify({ box, urlEnd }),
);

// Moving from the link onto the button keeps it.
await moveTo(box.left + box.width / 2, box.top + box.height / 2, true);
await sleep(500);
r.ok('moving the pointer onto it keeps it', (await state()).shown === true);

// Clicking copies, says so, and goes.
await client.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: Math.round(box.left + box.width / 2),
  y: Math.round(box.top + box.height / 2),
  button: 'left',
  clickCount: 1,
  modifiers: 4,
});
await client.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: Math.round(box.left + box.width / 2),
  y: Math.round(box.top + box.height / 2),
  button: 'left',
  clickCount: 1,
  modifiers: 4,
});
await sleep(150);
const copied = await state();
r.ok('clicking it copies', copied.copied === true, JSON.stringify(copied));
r.ok(
  'and says so',
  String(await evaluate(client, `document.querySelector('.link-copy').textContent`)).includes(
    'Copied',
  ),
);
r.ok('then goes away by itself', await shownWithin(2500, false));
r.ok(
  'and the click did not open the link or reach the terminal',
  (await evaluate(
    client,
    `!document.querySelector('.cmd-panel') || document.querySelector('.cmd-panel').hidden`,
  )) === true,
);

// Letting go of Command takes it away.
await hover(60, row + 6.5);
await hover(8, row + 0.5);
r.ok('it comes back over the link', await shownWithin(3000));
await metaKey('keyUp');
await moveTo(geo.left + 8 * geo.cellWidth, geo.top + (row + 0.5) * geo.cellHeight, false);
r.ok('and letting go of Command hides it', await shownWithin(1000, false));

// Without Command nothing is offered.
await hover(60, row + 6.5, false);
await hover(8, row + 0.5, false);
await sleep(800);
r.ok('without Command there is no button', (await state()).shown === false);

// A path gets the same offer as a URL.
await type(client, 'clear; echo /usr/bin\r');
await sleep(2500);
const pathLines = (await evaluate(client, `window.__tabterm.readScreen()`)).split('\n');
const pathRow = pathLines.findIndex((l) => l.trim() === '/usr/bin');
await metaKey('rawKeyDown');
await hover(60, pathRow + 6.5);
await hover(4, pathRow + 0.5);
r.ok('a path gets a copy button too', await shownWithin(3000), JSON.stringify(await state()));
r.ok('for that path', (await state()).text === '/usr/bin', (await state()).text);
await metaKey('keyUp');
await moveTo(geo.left + 4 * geo.cellWidth, geo.top + (pathRow + 0.5) * geo.cellHeight, false);
await shownWithin(1000, false);

await finish();
r.done();
