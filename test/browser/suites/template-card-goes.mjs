// The card describing a template belongs to the start screen, and goes when the start screen does.
//
// Reported with a screenshot: a template was opened, four terminals appeared, and the card that
// describes that template was still sitting in the corner over the top of them.
//
// It is shown on a timer, a third of a second after the pointer lands on a chip, so that crossing
// the row does not flash one card per chip. Clicking a chip opens the template and takes the start
// screen away, and the chip goes with it, so the `mouseleave` that would have cancelled the timer
// never happens: the pointer has not moved, the thing under it has.
import { openTerminal, evaluate, sleep, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(800);

const chip = JSON.parse(
  String(
    await evaluate(
      client,
      `(() => {
         const el = document.querySelector('.launcher-template');
         if (!el) return 'null';
         const b = el.getBoundingClientRect();
         return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
       })()`,
    ),
  ),
);
r.ok('there is a template to open', chip !== null, JSON.stringify(chip));

const cards = async () =>
  Number(await evaluate(client, `document.querySelectorAll('.template-card').length`));

/*
 * A real pointer, because the card is shown from a `mouseenter` and taken away by a `mouseleave`,
 * and the whole fault is which of those the browser does and does not send.
 */
await client.send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: chip.x,
  y: chip.y,
  button: 'none',
});
r.ok('hovering does not show it instantly', (await cards()) === 0);

/*
 * Clicked while the card is still on its way, which is the whole of the report: the pointer lands,
 * the timer starts, and the click lands before it fires.
 */
await sleep(120);
await client.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: chip.x,
  y: chip.y,
  button: 'left',
  clickCount: 1,
});
await client.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: chip.x,
  y: chip.y,
  button: 'left',
  clickCount: 1,
});

// The template opens, which is what makes this a page the card must not be on.
const opened = await waitUntil(
  async () => Number(await evaluate(client, 'window.__tabterm.paneIds().length')) > 1,
  25000,
);
r.ok(
  'the template opened',
  opened,
  String(await evaluate(client, 'window.__tabterm.paneIds().length')),
);

/*
 * Watched past the delay rather than sampled once, because the card arrives late by construction:
 * checking immediately after the click would pass whether or not it is fixed.
 */
let seen = 0;
const until = Date.now() + 4000;
while (Date.now() < until) {
  if ((await cards()) > 0) seen += 1;
  await sleep(60);
}
r.ok(
  'and no card describing it is left over the terminals',
  seen === 0,
  `${String(seen)} samples had one`,
);

// And the start screen really is gone, so the check above was not watching a page that still has one.
r.ok(
  'with the start screen dismissed',
  (await evaluate(client, `document.querySelector('.launcher')?.hidden !== false`)) === true,
);

await finish();
r.done();
