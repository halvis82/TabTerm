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
/*
 * A tab is a wash behind its cards now, and the cards are members of the one grid tagged with the
 * tab they belong to. Nothing is nested, which is what keeps every card on the same pitch.
 */
const group = `.session-wash[data-workspace-id="${mine}"]`;
const inGroup = `.session-card[data-group="${mine}"]`;

const shape = async () =>
  JSON.parse(
    String(
      await evaluate(
        viewer.client,
        `JSON.stringify({
           cards: document.querySelectorAll('.session-card').length,
           groups: document.querySelectorAll(${JSON.stringify(group)}).length,
           inGroups: document.querySelectorAll(${JSON.stringify(inGroup)}).length,
           /* A box drawn around a single card says nothing, wherever it came from. */
           /* A wash with fewer than two cards on it is a tab drawn around a single terminal. */
           lonely: [...document.querySelectorAll('.session-wash')].filter((w) =>
             [...document.querySelectorAll('.session-card')]
               .filter((c) => c.dataset.group === w.dataset.group).length < 2).length,
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
      `JSON.stringify([...document.querySelectorAll('${inGroup}')]
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
 * And every card of a kind is the same height as every other of that kind.
 *
 * Cards in a group are one height and cards standing alone are another, deliberately: a lone card
 * is taller by exactly what a group's border, padding and title cost, so the two kinds of row come
 * out level. What must never happen is a card being stretched by what happens to sit beside it,
 * which is what a grid does to its items by default and what the row check below pins.
 */
const heights = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `JSON.stringify({
         grouped: [...document.querySelectorAll('.session-card[data-group]')]
           .map((c) => Math.round(c.getBoundingClientRect().height)),
         alone: [...document.querySelectorAll('.session-grid > .session-card')]
           .map((c) => Math.round(c.getBoundingClientRect().height)),
       })`,
    ),
  ),
);
r.ok(
  'every card in a group is the height of the others in it',
  new Set(heights.grouped).size === 1,
  JSON.stringify(heights),
);
r.ok(
  'and every card standing alone is the height of the other lone ones',
  new Set(heights.alone).size <= 1,
  JSON.stringify(heights),
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
 * The wash covers the cards it belongs to, rather than being a box that holds them.
 *
 * Which is what keeps the grid even: every card is a member of the one grid, on the same pitch,
 * and the tab's colour is painted over the same cells and a few pixels past. A box around them was
 * taller than what it held, so the cards beside it lined up with nothing.
 */
const covers = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const wash = document.querySelector(${JSON.stringify(group)});
         const cards = [...document.querySelectorAll(${JSON.stringify(inGroup)})];
         if (!wash || cards.length === 0) return 'null';
         const w = wash.getBoundingClientRect();
         return JSON.stringify({
           washHeight: Math.round(w.height),
           coversAll: cards.every((c) => {
             const b = c.getBoundingClientRect();
             return b.top >= w.top - 1 && b.bottom <= w.bottom + 1 &&
                    b.left >= w.left - 1 && b.right <= w.right + 1;
           }),
         });
       })()`,
    ),
  ),
);
r.ok(
  'the tab colour is drawn behind its cards, covering all of them',
  covers !== null && covers.coversAll === true && covers.washHeight > 100,
  JSON.stringify(covers),
);

/*
 * And a card inside a group is the size a card outside one is./*
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
         const inside = document.querySelector('${inGroup}');
         const outside = [...document.querySelectorAll('.session-card')]
           .find((c) => c.dataset.group === undefined);
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
  'a grouped card is about the width of an ungrouped one',
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
      `JSON.stringify([...document.querySelectorAll('${inGroup}')]
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
 * A fourth pane, which is what makes the shape interesting: three across and two down, with one
 * card on the last row. The colour has to turn back on itself there rather than reserve two cells
 * that hold nothing, and the corner where it turns has to be rounded like every other.
 */
await evaluate(work.client, "window.__tabterm.split('horizontal')");
await waitFor(work.client, 'window.__tabterm.paneIds().length === 4', 20000);
await sleep(1200);
const fourth = JSON.parse(
  String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneIds())')),
).at(-1);
await evaluate(work.client, `window.__tabterm.focus(${JSON.stringify(fourth)})`);
await sleep(400);
await type(work.client, 'echo GROUP-FOUR\r');
await waitUntil(async () => (await shape()).inGroups >= 4, 25000);
await sleep(1500);

const outline = String(
  await evaluate(
    viewer.client,
    `document.querySelector(${JSON.stringify(group)} + ' svg path')?.getAttribute('d') ?? ''`,
  ),
);
const arcs = [...outline.matchAll(/A [\d.]+ [\d.]+ 0 0 (\d)/g)].map((m) => m[1]);
r.ok('the tab colour is drawn as an outline', arcs.length > 0, outline.slice(0, 90));
/*
 * Whether this tab's last row is short depends on the window: three panes are one row of three in a
 * wide list and two rows in a narrow one. So the shape is read from the cards rather than assumed,
 * and the outline is checked against what they actually make.
 */
const shapeNow = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const cards = [...document.querySelectorAll(${JSON.stringify(inGroup)})];
         const rights = cards.map((c) => Math.round(c.getBoundingClientRect().right));
         const last = rights[rights.length - 1] ?? 0;
         return JSON.stringify({ cards: cards.length, short: last < Math.max(...rights) - 8 });
       })()`,
    ),
  ),
);
r.ok(
  shapeNow.short
    ? 'with a corner that turns inward where its last row ends'
    : 'and it is a plain rectangle when the last row is full',
  shapeNow.short
    ? arcs.length === 6 && arcs.filter((a) => a === '0').length === 1
    : arcs.length === 4 && arcs.every((a) => a === '1'),
  `${JSON.stringify(arcs)} ${JSON.stringify(shapeNow)}`,
);
/*
 * And only the colour answers the pointer. The cells a short last row gives up hold other people's
 * terminals, and hovering or opening a tab they have nothing to do with is what the rectangle did.
 */
const hitArea = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const wash = document.querySelector(${JSON.stringify(group)});
         const path = wash?.querySelector('svg path');
         if (!wash || !path) return 'null';
         return JSON.stringify({
           box: getComputedStyle(wash).pointerEvents,
           paint: getComputedStyle(path).pointerEvents,
         });
       })()`,
    ),
  ),
);
r.ok(
  'the rectangle it is drawn in answers nothing',
  hitArea !== null && hitArea.box === 'none',
  JSON.stringify(hitArea),
);
r.ok(
  'and the colour itself does',
  hitArea !== null && hitArea.paint !== 'none',
  JSON.stringify(hitArea),
);

r.ok(
  'and every corner of it is rounded',
  arcs.length > 0 && !/L [\d.]+ [\d.]+ L/.test(outline),
  outline.slice(0, 120),
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
 * And with one fewer pane the colour turns back on itself, which is the shape that was drawn with
 * knife edges before. Three cards in a two column list is two rows with one on the last, which is
 * the same shape a seven pane tab makes in a three column one.
 */
await sleep(1500);
const afterLeaving = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const cards = [...document.querySelectorAll(${JSON.stringify(inGroup)})];
         const rights = cards.map((c) => Math.round(c.getBoundingClientRect().right));
         const d = document.querySelector(${JSON.stringify(group)} + ' svg path')?.getAttribute('d') ?? '';
         const arcs = [...d.matchAll(/A [\\d.]+ [\\d.]+ 0 0 (\\d)/g)].map((m) => m[1]);
         const last = rights[rights.length - 1] ?? 0;
         const wash = document.querySelector(${JSON.stringify(group)});
         const wb = wash?.getBoundingClientRect();
         return JSON.stringify({
           arcs, short: last < Math.max(...rights) - 8, cards: cards.length,
           washes: document.querySelectorAll('.session-wash').length,
           box: wb ? Math.round(wb.width) + 'x' + Math.round(wb.height) : 'none',
           hasSvg: !!wash?.querySelector('svg'), d: d.slice(0, 40),
         });
       })()`,
    ),
  ),
);
if (!afterLeaving.short) {
  r.skip('the colour turns inward around a short last row', 'this width leaves no short row');
} else {
  r.ok(
    'the colour turns inward around a short last row',
    afterLeaving.arcs.length === 6 && afterLeaving.arcs.filter((a) => a === '0').length === 1,
    JSON.stringify(afterLeaving),
  );

  /*
   * And the notch is cut where a tab ending there would end, so whatever moves into those cells is
   * the same distance away as any other neighbour.
   *
   * It was cut from the last row's top instead, which put the edge exactly where the colour of the
   * thing in the notch begins: the two touched and read as one tab.
   */
  const notchGap = JSON.parse(
    String(
      await evaluate(
        viewer.client,
        `(() => {
           const wash = document.querySelector(${JSON.stringify(group)});
           const cards = [...document.querySelectorAll(${JSON.stringify(inGroup)})];
           const d = wash?.querySelector('svg path')?.getAttribute('d') ?? '';
           const box = wash?.getBoundingClientRect();
           if (!box || cards.length < 2) return 'null';
           const rects = cards.map((c) => c.getBoundingClientRect());
           const lastTop = rects[rects.length - 1].top;
           const above = Math.max(...rects.map((r2) => r2.bottom).filter((b) => b <= lastTop + 1));
           /* The y the outline turns inward at, in page coordinates. */
           const ys = [...d.matchAll(/[ML] [-\\d.]+ ([-\\d.]+)/g)].map((m) => Number(m[1]) + box.top);
           /* The lowest turn above the last row, which is the one the notch is cut at: the
              corners at the top of the outline are far higher. */
           const above_ = ys.filter((y) => y < lastTop - 1);
           const turn = above_.length > 0 ? Math.max(...above_) : undefined;
           return JSON.stringify({
             reachPastRowAbove: turn === undefined ? null : Math.round(turn - above),
             gapToNextRow: Math.round(lastTop - above),
           });
         })()`,
      ),
    ),
  );
  r.ok(
    'and the notch is cut the same distance past the row above as anywhere else',
    notchGap !== null &&
      notchGap.reachPastRowAbove !== null &&
      notchGap.reachPastRowAbove >= 3 &&
      notchGap.reachPastRowAbove <= 6,
    JSON.stringify(notchGap),
  );
}

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
/*
 * Pressed on the colour itself, in the band it reaches past the cards.
 *
 * The cards are not inside it any more: they are members of the grid and the colour is painted
 * behind them, so the middle of its box is a card and the band around them is the part that
 * belongs to the tab. Only the paint answers the pointer, which is the point.
 */
/*
 * Waited for the outline, because a hidden tab places its list on a throttled timer.
 *
 * Neither animation frames nor resize observers run in a tab nobody is looking at, so the list is
 * placed by a timer instead, and a timer there fires about once a second. Measuring before that is
 * measuring a grid the browser has arranged for itself.
 */
await waitUntil(async () => {
  const drawn = String(
    await evaluate(
      viewer.client,
      `document.querySelector(${JSON.stringify(group)} + ' svg path')?.getAttribute('d') ?? ''`,
    ),
  );
  return drawn.length > 0;
}, 15000);

const bandAt = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const wash = document.querySelector(${JSON.stringify(group)});
         if (!wash) return 'null';
         wash.scrollIntoView({ block: 'center' });
         const b = wash.getBoundingClientRect();
         const x = Math.round(b.left + 2);
         const y = Math.round(b.top + b.height / 2);
         const at = document.elementFromPoint(x, y);
         const path = wash.querySelector('svg path');
         const pb = path?.getBoundingClientRect();
         return JSON.stringify({
           x, y,
           hit: at ? (at.tagName + '.' + (at.getAttribute('class') ?? '')) : 'nothing',
           box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
           d: (path?.getAttribute('d') ?? '').slice(0, 30),
           pathBox: pb ? [Math.round(pb.left), Math.round(pb.top), Math.round(pb.width), Math.round(pb.height)] : null,
           pe: path ? getComputedStyle(path).pointerEvents : 'none',
         });
       })()`,
    ),
  ),
);
let pressedGroup = bandAt !== null;
if (bandAt) {
  for (const kind of ['mousePressed', 'mouseReleased']) {
    await viewer.client.send('Input.dispatchMouseEvent', {
      type: kind,
      x: bandAt.x,
      y: bandAt.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await sleep(400);
}
r.ok('the group itself can be pressed', pressedGroup);
const cameForward = await waitUntil(async () => isActive(work.client), 15000);
r.ok('and pressing it opens the tab those panes are in', cameForward, JSON.stringify(bandAt));

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
    Number(await evaluate(again.client, `document.querySelectorAll('${inGroup}').length`)) >= 2,
  20000,
);
const wanted = String(
  await evaluate(
    again.client,
    `(() => {
       const cards = [...document.querySelectorAll('${inGroup}')];
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
    Number(await evaluate(watcher, `document.querySelectorAll('${inGroup}').length`)) >= 2,
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
         const card = document.querySelector(${JSON.stringify(inGroup)});
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
/*
 * The wording depends on how many panes go with it. This card is in a tab of three, so the entry
 * counts them: seven terminals leaving the screen at once is a different proposition from one and
 * the menu says so before the press. A tab of one keeps the shorter wording.
 */
const closesTheirTab = labels.find(
  (l) => l === 'Close the tab it is in' || /^Close the tab with these \d+ panes$/.test(l),
);
r.ok(
  'the menu on a card offers to close the tab that card is in',
  closesTheirTab !== undefined,
  JSON.stringify(labels),
);
r.ok(
  'and says how many panes go with it',
  closesTheirTab === 'Close the tab with these 3 panes',
  String(closesTheirTab),
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
const workspaceClosing = String(await evaluate(work.client, 'window.__tabterm.workspaceId()'));
const stillOpen = async () =>
  Number(
    await evaluate(
      watcher,
      `new Promise((d) => chrome.tabs.query({}, (t) => d(t.filter((x) =>
         (x.url ?? '').includes(${JSON.stringify(workspaceClosing)})).length)))`,
    ),
  );
r.ok('the tab it names is open before the press', (await stillOpen()) === 1);
await realClick(watcher, '.term-menu button', closesTheirTab);
/*
 * The tab is named rather than counted. Other tabs in this run close themselves at moments of
 * their own, so a count going down by one proves nothing about which one went.
 */
const closed = await waitUntil(async () => (await stillOpen()) === 0, 10000);
r.ok('and pressing it closes that tab', closed, `${String(await stillOpen())} still open`);

r.ok(
  'while this one is still here',
  String(await evaluate(watcher, 'typeof document')) === 'object',
);

await finish();
r.done();
