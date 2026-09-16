// Running Now shows which sessions share a tab, laid out the way that tab is.
//
// The list was every session as an equal card, so four panes of one tab looked exactly like four
// unrelated terminals. What had to stay true while fixing that is most of this file: every session
// still appears, the order does not move, a session alone in its tab is drawn exactly as it was,
// and nothing about a session that has gone or is in the background changes.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter, closeTab } from '../cdp.mjs';

const r = reporter();

// A tab with two panes, split side by side, both used so they are real entries in the list.
const work = await openTerminal();
await waitFor(work.client, "document.querySelector('.launcher-input')");
await type(work.client, 'echo GROUP-ONE\r');
await waitFor(work.client, `(window.__tabterm.readScreen() ?? '').includes('GROUP-ONE')`, 20000);
await evaluate(work.client, "window.__tabterm.split('horizontal')");
await waitFor(work.client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1500);
const [, second] = JSON.parse(
  String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneIds())')),
);
await evaluate(work.client, `window.__tabterm.focus(${JSON.stringify(second)})`);
await sleep(500);
await type(work.client, 'echo GROUP-TWO\r');
await sleep(1500);

// A separate tab with one session, which must be drawn exactly as it always was.
const alone = await openTerminal();
await waitFor(alone.client, "document.querySelector('.launcher-input')");
await type(alone.client, 'echo ALONE\r');
await sleep(1500);

// A third tab to read the list from, so the list is about other people's sessions.
const viewer = await openTerminal();
await waitFor(viewer.client, "document.querySelector('.launcher-input')");
await sleep(2000);

const shape = async () =>
  JSON.parse(
    String(
      await evaluate(
        viewer.client,
        `JSON.stringify({
           cards: document.querySelectorAll('.session-card').length,
           groups: document.querySelectorAll('.session-group').length,
           inGroups: document.querySelectorAll('.session-group .session-card').length,
           rows: document.querySelectorAll('.session-split.is-horizontal').length,
           columns: document.querySelectorAll('.session-split.is-vertical').length,
         })`,
      ),
    ),
  );

const grouped = await waitUntil(async () => (await shape()).groups === 1, 20000);
r.ok('the two panes of one tab are drawn as one group', grouped, JSON.stringify(await shape()));

const now = await shape();
r.ok('with both of them inside it', now.inGroups === 2, JSON.stringify(now));
/*
 * Every session still appears. Grouping that hid anything would be worse than no grouping: this
 * list is how somebody finds a terminal they left running.
 */
r.ok(
  'and every session is still on the list, grouped or not',
  now.cards >= 3,
  `${String(now.cards)} cards for two grouped and at least one alone`,
);
r.ok(
  'the session that is alone in its tab is not put in a group',
  now.cards - now.inGroups >= 1,
  JSON.stringify(now),
);

/*
 * And the shape is the tab's own. A side-by-side split is drawn side by side, which is the whole
 * reason the arrangement is sent rather than just the membership.
 */
r.ok(
  'a side by side tab is drawn side by side',
  now.rows === 1 && now.columns === 0,
  JSON.stringify(now),
);

/*
 * And a card inside a group is the size a card outside one is.
 *
 * The first version gave every group the whole row, which made a pair of terminals into a banner
 * across the list. The group takes as many columns as the tab is wide instead, so the cards inside
 * keep the width they would have had on their own. Measured rather than read off the CSS, because
 * what matters is what the grid actually did with it.
 */
const widths = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const inside = document.querySelector('.session-group .session-card');
         const outside = [...document.querySelectorAll('.session-card')]
           .find((c) => !c.closest('.session-group'));
         if (!inside || !outside) return 'null';
         return JSON.stringify({
           inside: Math.round(inside.getBoundingClientRect().width),
           outside: Math.round(outside.getBoundingClientRect().width),
           group: Math.round(document.querySelector('.session-group').getBoundingClientRect().width),
           grid: Math.round(document.querySelector('.session-grid').getBoundingClientRect().width),
         });
       })()`,
    ),
  ),
);
r.ok(
  'a grouped card is about the size of an ungrouped one',
  widths !== null && Math.abs(widths.inside - widths.outside) <= 30,
  JSON.stringify(widths),
);
/*
 * And it asks for exactly as many columns as the tab is wide.
 *
 * Not "narrower than the row", which is only true when the list has more columns than the tab has
 * panes: at a narrow width the grid has two columns and a two pane tab fills them, correctly. The
 * rule is the span, and that holds at any width.
 */
const span = String(
  await evaluate(
    viewer.client,
    `getComputedStyle(document.querySelector('.session-group')).gridColumn`,
  ),
);
r.ok('and it asks for as many columns as the tab is wide', span.includes('span 2'), span);

/*
 * Stacked, which must change the drawing rather than only the membership.
 *
 * Something is run in the new pane before it is expected here. `Running now` lists sessions
 * somebody could return to, and deliberately leaves out a pane that has printed nothing, so a
 * freshly split shell is correctly absent until it has done something.
 */
await evaluate(work.client, "window.__tabterm.split('vertical')");
await waitFor(work.client, 'window.__tabterm.paneIds().length === 3', 20000);
await sleep(1500);
const third = JSON.parse(
  String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneIds())')),
).at(-1);
await evaluate(work.client, `window.__tabterm.focus(${JSON.stringify(third)})`);
await sleep(500);
await type(work.client, 'echo GROUP-THREE\r');
await waitUntil(
  async () =>
    String(
      await evaluate(work.client, `window.__tabterm.readScreen(${JSON.stringify(third)}) ?? ''`),
    ).includes('GROUP-THREE'),
  20000,
);
await sleep(2500);
const stacked = await waitUntil(async () => (await shape()).columns >= 1, 20000);
r.ok('and a stacked split is drawn stacked', stacked, JSON.stringify(await shape()));

/*
 * Moving a pane out of the tab, which is the case he asked about by name. Both sides have to
 * follow: the group loses a pane and the list gains a session that is alone.
 */
const before = await shape();
/*
 * The pane that is focused is the one that moves, which is what the menu item does, so the pane to
 * move is focused first rather than named.
 */
const panesNow = JSON.parse(
  String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneIds())')),
);
await evaluate(work.client, `window.__tabterm.focus(${JSON.stringify(panesNow.at(-1))})`);
await sleep(400);
await evaluate(work.client, 'window.__tabterm.detachPane()');
await sleep(500);
r.ok(
  'a pane was asked to move to its own tab',
  Number(await evaluate(work.client, 'window.__tabterm.paneIds().length')) < panesNow.length,
  `${String(panesNow.length)} panes before`,
);

const shrank = await waitUntil(async () => (await shape()).inGroups < before.inGroups, 25000);
r.ok(
  'the group follows a pane leaving it',
  shrank,
  `${JSON.stringify(before)} -> ${JSON.stringify(await shape())}`,
);
r.ok(
  'and the session it became is still on the list',
  (await shape()).cards >= before.cards,
  JSON.stringify(await shape()),
);

/*
 * And a tab that goes away entirely takes its group with it rather than leaving an empty box.
 */
await closeTab(alone.tabId ?? alone.id);
await sleep(2500);
r.ok(
  'nothing is left drawing an empty group',
  (await shape()).groups <= 1,
  JSON.stringify(await shape()),
);

await finish();
r.done();
