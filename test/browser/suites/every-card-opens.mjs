// A session listed in Running Now can always be opened, including one belonging to no workspace.
//
// Reported: "there should never be a case where i can't open a session that is displayed in
// running now on homescreen." His sequence was a split tab, close the pane holding the work, then
// close the tab while the other pane was an untouched shell.
//
// That leaves the session alive and in no layout: closing a pane takes it out of the workspace but
// keeps it running for its undo window, and closing the tab drops the workspace. The card was
// still drawn, and the click handler began `if (!session.workspaceId) return`, so pressing it did
// nothing at all. A card that does nothing is worse than one that is not there.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  type,
  openPaneMenu,
  realClick,
} from '../helpers.mjs';
import { reporter, closeTab } from '../cdp.mjs';

const r = reporter();

// A tab with work in it, then split, so that closing one pane leaves the other alive.
const donor = await openTerminal();
await waitFor(donor.client, "document.querySelector('.launcher-input')");
await type(donor.client, 'echo ORPHAN-ME');
await sleep(2500);

const box = JSON.parse(
  await evaluate(
    donor.client,
    `(() => { const b = document.querySelector('.pane').getBoundingClientRect();
              return JSON.stringify({ x: Math.round(b.left + b.width / 2),
                                      y: Math.round(b.top + b.height / 2) }); })()`,
  ),
);
await openPaneMenu(donor.client, box.x, box.y);
await realClick(donor.client, '.term-menu-item', 'Split right');
await sleep(1800);
await evaluate(donor.client, "document.querySelector('.term-menu')?.remove()");
const panes = Number(await evaluate(donor.client, `document.querySelectorAll('.pane').length`));
r.ok('the tab is split in two', panes === 2, String(panes));

/**
 * Close the pane holding the work, which is what takes it out of the layout while leaving it
 * running, and then close the tab, which drops the workspace it used to be in.
 */
/**
 * The session this suite is about, named before it is orphaned.
 *
 * A full run has other suites' sessions in the same list, so picking the first card finds
 * somebody else's work. This one is followed by its own id from here on.
 */
const mine = String(
  await evaluate(donor.client, `window.__tabterm.paneFacts()[0]?.sessionId ?? ''`),
);
r.ok('the session under test is identified', mine !== '', mine);

// The focused pane is the one the split just made; closing the other is what orphans the work,
// so the pane holding it is focused first.
await evaluate(
  donor.client,
  `document.querySelectorAll('.pane')[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`,
);
await sleep(500);
await evaluate(donor.client, `window.__tabterm.closePane()`);
await sleep(1800);
await closeTab(donor.tab.id);
await sleep(2500);

// A fresh tab, showing the start screen and its Running Now list.
const here = await openTerminal();
await waitFor(here.client, "document.querySelector('.launcher-input')");
await sleep(2500);

const cards = async () =>
  JSON.parse(
    await evaluate(
      here.client,
      `JSON.stringify([...document.querySelectorAll('.session-card')].map((c) => c.dataset.sessionId))`,
    ),
  );
r.ok(
  'Running Now lists something to open',
  (await cards()).length > 0,
  String((await cards()).length),
);

const before = await evaluate(here.client, `location.href`);
await evaluate(here.client, `[...document.querySelectorAll('.session-card')][0]?.click()`);
await sleep(3500);

const after = await evaluate(here.client, `location.href`);
const paneNow = Number(await evaluate(here.client, `document.querySelectorAll('.pane').length`));
const screen = String(await evaluate(here.client, `window.__tabterm.readViewport() ?? ''`));

r.ok('pressing the card does something', after !== before || paneNow >= 1, `${before} -> ${after}`);
r.ok(
  'and the tab is showing a terminal rather than the start screen',
  Number(await evaluate(here.client, `document.querySelectorAll('.launcher-input').length`)) === 0,
  screen.slice(0, 80),
);

await finish();
r.done();
