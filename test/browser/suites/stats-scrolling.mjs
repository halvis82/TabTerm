// Scrolling the Stats page goes where it is pushed, and stays there.
//
// Reported as: scroll to the bottom, try to scroll back up, and it lags so badly you are almost
// stuck at the bottom. The page is live while it is open, which is deliberate, and being live
// means it is redrawn whenever a command finishes. A redraw replaces the whole body, and a scroll
// position belongs to the element being replaced.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
// Something in the history, so the Stats page has enough on it to scroll.
/*
 * Enough history that the page is genuinely long, which is the condition the fault needs.
 *
 * On a page that barely scrolls, scrolling works and this passes. It first reproduced in a full
 * run, where the daemon had been used by sixty other suites and the page was nearly twice as
 * tall, which is also why it happens on a real machine and not on a fresh one.
 */
for (let i = 0; i < 24; i++) {
  await type(client, `echo stats-scroll-${String(i)}\r`);
  await sleep(90);
}
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('stats-scroll-23')`, 20000);

// Open the command panel and move to Stats.
await evaluate(
  client,
  `(() => { const b = document.getElementById('cmd-button'); if (b) b.click(); })()`,
);
await waitFor(client, `document.querySelector('.cmd-panel')?.hidden === false`, 10000);
await evaluate(
  client,
  `(() => {
     const tab = [...document.querySelectorAll('.cmd-panel button, .cmd-panel [role="tab"]')]
       .find((el) => (el.textContent ?? '').trim() === 'Stats');
     if (tab) tab.click();
   })()`,
);
await sleep(900);

/** The element the Stats page actually scrolls in, whichever it turns out to be. */
const scroller = `(() => {
  const panel = document.querySelector('.cmd-panel');
  if (!panel) return null;
  const all = [panel, ...panel.querySelectorAll('*')];
  return all.find((el) => el.scrollHeight > el.clientHeight + 8) ?? null;
})()`;

const canScroll = await waitFor(client, `${scroller} !== null`, 10000);
r.ok(
  'the Stats page has more on it than fits, so there is something to scroll',
  canScroll === true,
);

const read = async () => Number(await evaluate(client, `${scroller}?.scrollTop ?? -1`));
const height = Number(await evaluate(client, `${scroller}?.scrollHeight ?? 0`));

/*
 * Scrolled with real wheel events, not by assigning `scrollTop`.
 *
 * Assigning the property is not the thing being reported. It sets the position in one step and
 * nothing can interfere with it, so it passes on a page that is impossible to scroll by hand. A
 * wheel event is what a trackpad sends, it is delivered where the pointer is, and it can be fought
 * by anything that moves or redraws the element underneath.
 */
const box = JSON.parse(
  String(
    await evaluate(
      client,
      `(() => { const el = ${scroller}; const b = el.getBoundingClientRect();
         return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }); })()`,
    ),
  ),
);

const wheel = async (deltaY) => {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: box.x,
    y: box.y,
    deltaX: 0,
    deltaY,
    pointerType: 'mouse',
  });
};

// All the way down, the way somebody flicks to the bottom.
for (let i = 0; i < 12; i++) await wheel(200);
await sleep(600);
const bottom = await read();
r.ok('it goes to the bottom', bottom > 0, String(bottom));

/*
 * Then back up, a wheel notch at a time.
 *
 * The report is not that scrolling up is impossible, it is that it fights back. So each notch is
 * measured: what matters is whether the position it reached is a position it keeps.
 */
const [pane] = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
);
const keepBusy = setInterval(() => {
  const data = JSON.stringify(`echo busy${String.fromCharCode(13)}`);
  void evaluate(client, `window.__tabterm.sendInput(${JSON.stringify(pane)}, ${data})`);
}, 300);

let fought = 0;
let position = bottom;
for (let i = 0; i < 8; i++) {
  const before = position;
  await wheel(-120);
  await sleep(250);
  const landed = await read();
  // Only counted where there was somewhere to go. At the top a notch correctly does nothing.
  if (before > 20 && landed >= before) fought += 1;
  position = landed;
}

/*
 * And the position survives a redraw, which is the mechanism underneath the report.
 *
 * The page is live while it is open, so a command finishing rebuilds the whole body. A scroll
 * position belongs to the element being replaced, so somebody reading half way down is put back
 * wherever the new element starts, and doing that repeatedly while they scroll is what "it lags so
 * i'm almost stuck" describes from the outside.
 */
await wheel(240);
await sleep(300);
const mid = await read();
const data2 = JSON.stringify(`echo redraw-now${String.fromCharCode(13)}`);
await evaluate(client, `window.__tabterm.sendInput(${JSON.stringify(pane)}, ${data2})`);
await sleep(1200);
const afterRedraw = await read();
r.ok(
  'and a redraw behind the panel leaves the scroll position alone',
  Math.abs(afterRedraw - mid) <= 8,
  `${String(mid)} -> ${String(afterRedraw)}`,
);

clearInterval(keepBusy);

r.ok(
  'and scrolling up stays where it was put rather than being pulled back',
  fought === 0,
  `${String(fought)} of 8 notches were taken back, ended at ${String(position)} of ${String(height)}`,
);

await finish();
r.done();
