// A scroll moves the content by the distance it was scrolled, and not by some other distance.
//
// Reported as "scrolling is still really weird in claude in tabterm ... why is it natural there?
// does it mistake the window size or get a different amount of scrolls per scroll i send or
// something?". It did: the emulator converts a pixel delta to rows and damps anything under fifty
// pixels to thirty percent of itself. A wheel mouse never notices, one notch being more than that.
// A trackpad is nothing but small deltas, so a slow drag barely moved and a flick moved properly.
//
// Measured in rows against the pixels asked for, because that is the whole of the complaint.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'for i in $(seq 1 300); do echo "line $i"; done\r');
await waitUntil(
  async () =>
    String(await evaluate(client, `window.__tabterm.readScreen() ?? ''`)).includes('line 300'),
  20000,
);
await sleep(800);

const geo = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())')),
);
const at = async () => Number(await evaluate(client, 'window.__tabterm.viewportY()'));

/** Scroll up by this many pixels, the way a trackpad does, and say how many rows moved. */
const scrolled = async (pixels, times = 1) => {
  const before = await at();
  for (let i = 0; i < times; i++) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(geo.left + 60),
      y: Math.round(geo.top + 60),
      deltaX: 0,
      deltaY: -pixels,
      pointerType: 'mouse',
    });
    await sleep(40);
  }
  await sleep(500);
  return before - (await at());
};

r.ok('there is scrollback to scroll through', (await at()) > 20, String(await at()));

/*
 * One scroll, and then the same distance split into small pushes. Both must move the same, which
 * is the part that was wrong: the small ones were damped and the large one was not.
 */
const rowsPerBigPush = await scrolled(180);
r.ok(
  'a scroll of ten rows moves ten rows',
  Math.abs(rowsPerBigPush - 180 / geo.cellHeight) <= 1,
  `${String(rowsPerBigPush)} rows for ${String(Math.round(180 / geo.cellHeight))} rows of pixels`,
);

const rowsPerSmallPushes = await scrolled(20, 9);
r.ok(
  'and the same distance in small pushes moves the same',
  Math.abs(rowsPerSmallPushes - 180 / geo.cellHeight) <= 1,
  `${String(rowsPerSmallPushes)} rows for ${String(Math.round(180 / geo.cellHeight))} rows of pixels`,
);

/*
 * And a scroll smaller than a row is not thrown away. Three of them make a row, which is what
 * makes a slow drag move at all.
 */
const before = await at();
await scrolled(Math.round(geo.cellHeight / 3), 3);
r.ok(
  'three scrolls of a third of a row move one row',
  before - (await at()) === 1,
  `${String(before - (await at()))} rows`,
);

await finish();
r.done();
