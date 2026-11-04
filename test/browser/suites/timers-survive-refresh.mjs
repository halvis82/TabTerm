// The timer under each pane is still there after a refresh.
//
// Elapsed time is computed in the page from discrete events the daemon sends: a command started, a
// command ended, an agent turn began. That is the right design, because streaming a ticking clock
// would be continuous traffic to say something the receiver can work out for itself.
//
// The cost is that a page which has just loaded has received none of those events. So every timer
// in a reattached tab was blank until something next happened, and in a pane sitting idle nothing
// does. Refreshing looked like the timers had been lost rather than like they had never arrived,
// which is the same shape as the pane names before those were sent with the attach.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  decodePng,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

await type(client, 'echo TIMER-MARKER\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('TIMER-MARKER')`, 20000);
// Long enough that a label counting from the session start says something rather than nothing.
await sleep(2500);

const label = async () =>
  String(await evaluate(client, `document.querySelector('.pane-time')?.textContent ?? ''`));

const before = await label();
r.ok('a pane shows a timer before the refresh', before.length > 0, JSON.stringify(before));

await client.send('Page.reload');
await waitFor(client, 'window.__tabterm?.paneIds().length > 0', 25000);

/*
 * Waited for, but with nothing else happening in the pane.
 *
 * Nothing is typed after the reload on purpose. The fault is that the label only appears once an
 * event arrives, so a check that runs a command first would produce the event that hides it.
 */
const came = await waitUntil(async () => (await label()).length > 0, 15000);
r.ok(
  'and still shows one after it, with nothing happening in between',
  came,
  JSON.stringify(await label()),
);

// And it is counting from the session rather than from the moment the page loaded.
await sleep(3000);
const settled = await label();
r.ok(
  'and it counts from the session rather than from the page load',
  settled.length > 0,
  JSON.stringify(settled),
);

/*
 * The room under the last row is terminal, not page.
 *
 * Reported as "space wasted at the bottom of a terminal session": the label sat in a darker strip
 * that looked set aside for it. The strip was the page showing through the part of the pane a
 * whole number of rows does not fill.
 */
const where = JSON.parse(
  String(
    await evaluate(
      client,
      `(() => { const p = document.querySelector('.pane-terminal').getBoundingClientRect(); const x = document.querySelector('.xterm-screen').getBoundingClientRect(); return JSON.stringify({ strip: [Math.round(p.left + 40), Math.round(p.bottom - 2)], inside: [Math.round((x.left + x.right) / 2), Math.round(x.bottom - 4)], dpr: devicePixelRatio }); })()`,
    ),
  ),
);
const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
const png = decodePng(Buffer.from(data, 'base64'));
const at = ([x, y]) => {
  const o = (Math.round(y * where.dpr) * png.width + Math.round(x * where.dpr)) * png.channels;
  return [png.pixels[o], png.pixels[o + 1], png.pixels[o + 2]];
};
const strip = at(where.strip);
const inside = at(where.inside);
r.ok(
  'the space under the last row is painted the terminal color',
  strip.every((v, k) => Math.abs(v - (inside[k] ?? 0)) <= 2),
  JSON.stringify({ strip, inside }),
);

// Settings, Terminals, Show how long commands take.
await evaluate(client, "chrome.storage.local.set({ 'tabterm.showTimes': false })");
r.ok(
  'turning the time label off takes it away',
  await waitUntil(async () => (await label()) === '', 5000),
  JSON.stringify(await label()),
);
await evaluate(client, "chrome.storage.local.remove('tabterm.showTimes')");
r.ok(
  'and turning it back on brings it back',
  await waitUntil(async () => (await label()).length > 0, 5000),
  JSON.stringify(await label()),
);

await finish();
r.done();
