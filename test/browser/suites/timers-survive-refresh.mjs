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
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
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

await finish();
r.done();
