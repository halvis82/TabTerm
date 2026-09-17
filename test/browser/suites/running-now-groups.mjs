// Running Now shows which sessions share a tab, laid out the way that tab is.
//
// The list was every session as an equal card, so four panes of one tab looked exactly like four
// unrelated terminals. What had to stay true while fixing that is most of this file: every session
// still appears, the order does not move, a session alone in its tab is drawn exactly as it was,
// and nothing about a session that has gone or is in the background changes.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  realClick,
  openPaneMenu,
} from '../helpers.mjs';
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

/*
 * Counted for **this** tab, not for the page.
 *
 * Suites share a daemon and run three at a time, so the list this reads has other suites' terminals
 * on it and one of them is another grouping suite. "One group on the page" was therefore a
 * statement about whoever else happened to be running. The group carries the workspace it is for,
 * so every count here asks about that one.
 */
const mine = String(await evaluate(work.client, 'window.__tabterm.workspaceId()'));
const group = `.session-group[data-workspace-id="${mine}"]`;

const shape = async () =>
  JSON.parse(
    String(
      await evaluate(
        viewer.client,
        `JSON.stringify({
           cards: document.querySelectorAll('.session-card').length,
           groups: document.querySelectorAll(${JSON.stringify(group)}).length,
           inGroups: document.querySelectorAll(${JSON.stringify(group + ' .session-card')}).length,
           /* A box drawn around a single card says nothing, wherever it came from. */
           lonely: [...document.querySelectorAll('.session-group')]
             .filter((g) => g.querySelectorAll('.session-card').length < 2).length,
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
 * Every card in a group is the same size as every other.
 *
 * This drew the tab's own splits at first, so a card's size came from the shape of the tab: one
 * pane of a three pane tab was tall with a stretched footer beside two short ones. A card is a
 * card. The arrangement decides the order they appear in and nothing else.
 */
const sizes = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `JSON.stringify([...document.querySelectorAll('${group} .session-card')]
         .map((c) => { const b = c.getBoundingClientRect();
           return { w: Math.round(b.width), h: Math.round(b.height) }; }))`,
    ),
  ),
);
r.ok(
  'every card in a group is the same height as the others',
  new Set(sizes.map((s2) => s2.h)).size === 1,
  JSON.stringify(sizes),
);
r.ok('and the same width', new Set(sizes.map((s2) => s2.w)).size === 1, JSON.stringify(sizes));

/*
 * And that is true of every card on the list, in a group or not.
 *
 * A card is one size: a head, a picture of a screen, a line underneath. Grid items fill their cell
 * by default, so a row holding a group of seven panes made the ordinary card beside it three cards
 * tall, footer stranded at the bottom of an empty box. Measured across the whole list rather than
 * within the group, because that is where the two kinds of item meet.
 */
const everyCard = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `JSON.stringify([...document.querySelectorAll('.session-card')]
         .map((c) => Math.round(c.getBoundingClientRect().height)))`,
    ),
  ),
);
r.ok(
  'every card on the list is the same height, grouped or not',
  new Set(everyCard).size === 1,
  JSON.stringify(everyCard),
);

/*
 * And a group is as tall as the cards in it, rather than being stretched to its row either.
 */
const stretched = String(
  await evaluate(
    viewer.client,
    `getComputedStyle(document.querySelector('.session-grid')).alignItems`,
  ),
);
r.ok('and nothing is stretched to the height of its row', stretched === 'start', stretched);

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
         const inside = document.querySelector('${group} .session-card');
         const outside = [...document.querySelectorAll('.session-card')]
           .find((c) => !c.closest('.session-group'));
         if (!inside || !outside) return 'null';
         return JSON.stringify({
           inside: Math.round(inside.getBoundingClientRect().width),
           outside: Math.round(outside.getBoundingClientRect().width),
           group: Math.round(document.querySelector('${group}').getBoundingClientRect().width),
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
  await evaluate(viewer.client, `getComputedStyle(document.querySelector('${group}')).gridColumn`),
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
const grew = await waitUntil(async () => (await shape()).inGroups >= 3, 20000);
r.ok('a third pane joins the group', grew, JSON.stringify(await shape()));

/*
 * And it is still a row of equal cards rather than the tab's tree. A stacked split used to be
 * drawn stacked, which is what made one card tall and its footer stretched.
 */
const afterThird = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `JSON.stringify([...document.querySelectorAll('${group} .session-card')]
         .map((c) => Math.round(c.getBoundingClientRect().height)))`,
    ),
  ),
);
r.ok(
  'and every card is still the same height as the others',
  new Set(afterThird).size === 1,
  JSON.stringify(afterThird),
);

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
/*
 * The tab, by the id it actually has. `tabId` is not a field on what `openTerminal` returns, so
 * this closed nothing at all and the check below was passing on a tab that was still open.
 */
await closeTab(alone.tab.id);
await sleep(2500);
r.ok(
  'nothing is left drawing an empty group',
  (await shape()).lonely === 0,
  JSON.stringify(await shape()),
);

/*
 * Last, because it ends this tab.
 *
 * Opening a session from a start screen nobody has used closes the tab it was opened from, which
 * is right: leaving it would show its own empty terminal the moment focus moved away, and that
 * reads as a second copy of the session. It does mean everything else here has to have run first.
 */
/*
 * The whole group answers a press, not only the cards in it.
 *
 * The background between and around them is part of the same object, and somebody aiming at a
 * group aims at the group. This presses the group's own heading, which is inside the box and is
 * not a card.
 */
const isActive = async (client) =>
  String(
    await evaluate(
      client,
      `new Promise((d) => chrome.tabs.getCurrent((t) => d(String(t.active))))`,
    ),
  ) === 'true';

await evaluate(
  work.client,
  `new Promise((d) => chrome.tabs.getCurrent((t) => {
  chrome.tabs.update(t.id, { active: false }, () => d(0));
}))`,
).catch(() => undefined);
await sleep(300);
const pressedGroup = await realClick(viewer.client, `${group} .session-group-title`);
r.ok('the group itself can be pressed', pressedGroup);
const cameForward = await waitUntil(async () => isActive(work.client), 15000);
r.ok('and pressing it opens the tab those panes are in', cameForward);

/*
 * And pressing one card in a group opens that tab **on that pane**.
 *
 * Four panes of a tab are four cards here, and all four of them opened the same tab on whichever
 * pane it happened to be left on, so the card somebody pressed was not the terminal they got. The
 * tab is what opens either way; which pane has the keyboard afterwards is the part being checked.
 *
 * A second start screen, because the press above closed the first one. Opening a session from a
 * start screen nobody has used closes the tab it was opened from, which is right: leaving it would
 * show its own empty terminal the moment focus moved away, and that reads as a second copy.
 */
const again = await openTerminal();
await waitFor(again.client, "document.querySelector('.launcher-input')");
await waitUntil(
  async () =>
    Number(
      await evaluate(again.client, `document.querySelectorAll('${group} .session-card').length`),
    ) >= 2,
  20000,
);
const wanted = String(
  await evaluate(
    again.client,
    `(() => {
       const cards = [...document.querySelectorAll('${group} .session-card')];
       return cards[cards.length - 1]?.dataset.sessionId ?? '';
     })()`,
  ),
);
await evaluate(work.client, `window.__tabterm.focus(window.__tabterm.paneIds()[0])`);
await sleep(400);
const opened = await realClick(again.client, `.session-card[data-session-id="${wanted}"]`);
r.ok('a card in a group can be pressed', opened && wanted !== '', wanted);
const landedOn = await waitUntil(async () => {
  const pairs = JSON.parse(
    String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneSessions())')),
  );
  const focused = String(await evaluate(work.client, 'window.__tabterm.focusedPane()'));
  return pairs.find((p) => p.paneId === focused)?.sessionId === wanted;
}, 15000);
r.ok('and the pane it names is the one with the keyboard', landedOn, `${wanted} was asked for`);

const onlooker = await openTerminal();
await waitFor(onlooker.client, "document.querySelector('.launcher-input')");
const watcher = onlooker.client;
await waitUntil(
  async () =>
    Number(await evaluate(watcher, `document.querySelectorAll('${group} .session-card').length`)) >=
    2,
  20000,
);

/*
 * "Close tab" on a card means that card's tab, not this one.
 *
 * Last of all, and from a start screen opened here for it, because taking the offer closes the tab
 * every check above reads from. The two presses before this one each close the start screen they
 * were made on, so this needs one of its own anyway.
 *
 * It sat at the bottom of every menu on this page and always closed the tab it was opened from. On
 * a card in Running Now that reads as an offer to close the tab the card is about, and it closed
 * the one you were working in instead. Reported in those words.
 */
const cardAt = JSON.parse(
  String(
    await evaluate(
      watcher,
      `(() => {
         const card = document.querySelector(${JSON.stringify(group + ' .session-card')});
         if (!card) return 'null';
         card.scrollIntoView({ block: 'center' });
         const b = card.getBoundingClientRect();
         return JSON.stringify({
           x: Math.round((b.left + b.right) / 2),
           y: Math.round(b.top + 12),
           sessionId: card.dataset.sessionId,
         });
       })()`,
    ),
  ),
);
r.ok('a card can be pointed at', cardAt !== null, JSON.stringify(cardAt));
await openPaneMenu(watcher, cardAt.x, cardAt.y);
const labels = JSON.parse(
  String(
    await evaluate(
      watcher,
      `JSON.stringify([...document.querySelectorAll('.term-menu button, .term-menu [role="menuitem"], .term-menu div')]
         .map((el) => (el.textContent ?? '').trim()).filter(Boolean))`,
    ),
  ),
);
r.ok(
  'the menu on a card offers to close the tab that card is in',
  labels.some((l) => l === 'Close the tab it is in'),
  JSON.stringify(labels),
);
r.ok(
  'and does not offer to close this one',
  !labels.some((l) => l === 'Close tab'),
  JSON.stringify(labels),
);

/*
 * And it does what it says: the tab holding those panes goes, this one stays, and the sessions
 * carry on, because closing a tab is not the same as ending a terminal.
 */
const tabsBefore = Number(
  await evaluate(
    watcher,
    `new Promise((d) => chrome.tabs.query({}, (t) => d(t.filter((x) => (x.url ?? '').includes('terminal.html')).length)))`,
  ),
);
await realClick(watcher, '.term-menu button', 'Close the tab it is in');
await sleep(2500);
const tabsAfter = Number(
  await evaluate(
    watcher,
    `new Promise((d) => chrome.tabs.query({}, (t) => d(t.filter((x) => (x.url ?? '').includes('terminal.html')).length)))`,
  ),
);
r.ok(
  'and the tab it named is the one that closed',
  tabsAfter === tabsBefore - 1,
  `${String(tabsBefore)} -> ${String(tabsAfter)}`,
);
r.ok(
  'while this one is still here',
  String(await evaluate(watcher, 'typeof document')) === 'object',
);

await finish();
r.done();
