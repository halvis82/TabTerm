// Kill session on the only pane in a tab ends the terminal and closes the tab.
//
// Reported: "tabs don't seem to be closing when there's only one session pane open in a tab and i
// right click and do kill session". A person choosing Kill has asked for the most explicit thing
// this product does, and it has to happen.
import {
  openTerminal,
  evaluate,
  sleep,
  waitFor,
  realClick,
  openPaneMenu,
  type,
} from '../helpers.mjs';
import { reporter, listTargets } from '../cdp.mjs';

const r = reporter();
const { client, tab } = await openTerminal();
await waitFor(client, "document.querySelector('.pane')");
await type(client, 'echo kill-closes-tab');
await waitFor(client, `document.querySelector('.launcher')?.hidden === true`, 10000);
await sleep(600);

r.ok(
  'one pane to kill',
  (await evaluate(client, `document.querySelectorAll('.pane').length`)) === 1,
);

await openPaneMenu(client, 200, 300);
const offered = await evaluate(
  client,
  `(() => { const b = [...document.querySelectorAll('.term-menu-item')]
     .find(x => (x.textContent || '').trim() === 'Kill session');
     return !b ? 'missing' : b.disabled ? 'disabled' : 'ready'; })()`,
);
r.ok('Kill session is offered and usable', String(offered) === 'ready', String(offered));

/**
 * The page's own identity, taken before it goes.
 *
 * Everything after the click has to be asked of the browser rather than of the page: a tab that
 * closes takes its debugging connection with it, and an `evaluate` against a closing page throws
 * something that reads like a harness fault rather than like the thing being tested.
 */
const targetId = tab.id;

await realClick(client, '.term-menu-item', 'Kill session');

/**
 * The tab goes, which is the whole report.
 *
 * "tabs don't seem to be closing when there's only one session pane open in a tab and i right
 * click and do kill session". Killing the only session left the tab sitting there with a dead
 * terminal in it: nothing at all closed it, and `Close session` beside it always had.
 */
let closed = false;
for (let i = 0; i < 40 && !closed; i++) {
  await sleep(300);
  const targets = await listTargets();
  closed = !targets.some((t) => t.id === targetId);
}
r.ok('killing the only session closes its tab', closed, `target ${targetId}`);

/**
 * Nothing to clean up, on purpose.
 *
 * `finish` ends the sessions of every tab it opened and then closes them, and the one tab this
 * suite opened has closed itself, which is the result being checked. Asking a page that is gone
 * to do anything leaves a promise nobody can settle, and the process then exits on that rather
 * than on the checks.
 */
r.done();
