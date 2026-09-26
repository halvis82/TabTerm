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

/**
 * Output arriving while you are reading scrollback does not move what you are reading.
 *
 * The other half of scrolling being trustworthy. A view that jumps to the bottom the moment a
 * background job prints takes the page out from under somebody mid-sentence, and it happens at
 * the least convenient time: while a long build or an agent is still talking. Nothing here asks
 * for that, so this is a check that nothing starts to.
 *
 * Output is made by a job that was already running, because typing is the one thing that **should**
 * scroll to the bottom: a keystroke means you want to see what you are typing. So the command is
 * sent first, then the scroll, then the printing happens on its own.
 */
await type(client, '(sleep 4; for i in $(seq 1 30); do echo late-$i; done) &\r');
await sleep(600);
// Well up into the scrollback, so a jump to the bottom would be unmissable.
await scrolled(300, 4);
const readingAt = await at();
r.ok('reading back through the scrollback', readingAt > 5, String(readingAt));

// Long enough for the job to have printed all of it.
await sleep(9000);
r.ok(
  'a background job printing does not move the view',
  (await at()) === readingAt,
  `was ${String(readingAt)}, now ${String(await at())}`,
);

/*
 * And the output really did arrive while the view stayed still, which is what makes the check
 * above mean anything: a job that never ran would hold the view just as well.
 */
for (let i = 0; i < 40; i++) {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(geo.left + 60),
    y: Math.round(geo.top + 60),
    deltaX: 0,
    deltaY: 300,
    pointerType: 'mouse',
  });
}
await sleep(700);
const atBottom = String(await evaluate(client, `window.__tabterm.readScreen() ?? ''`));
r.ok(
  'and it was there all along, at the bottom where it was printed',
  atBottom.includes('late-30'),
  atBottom.split('\n').filter(Boolean).slice(-2)[0] ?? '',
);

await finish();
r.done();
