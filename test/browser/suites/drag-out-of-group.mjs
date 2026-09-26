// Dragging a session out of the tab it shares, from the start screen.
//
// `Running now` draws the panes of one tab as a group. Pulling one out of that picture is the
// plainest way to say take it out of that tab, and it is the one gesture the group affords. What
// has to be true: the session leaves the tab, it gets a tab of its own beside the one it left, the
// person is not taken there, and a drop that lands on a group does nothing at all.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  dragOnto,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

// A tab with two used panes, which is what makes a group.
const work = await openTerminal();
await waitFor(work.client, "document.querySelector('.launcher-input')");
await type(work.client, 'echo DRAG-ONE\r');
await waitFor(work.client, `(window.__tabterm.readScreen() ?? '').includes('DRAG-ONE')`, 20000);
await evaluate(work.client, "window.__tabterm.split('horizontal')");
await waitFor(work.client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1500);
const [, second] = JSON.parse(
  String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneIds())')),
);
await evaluate(work.client, `window.__tabterm.focus(${JSON.stringify(second)})`);
await sleep(500);
await type(work.client, 'echo DRAG-TWO\r');
await sleep(2000);

/*
 * A session in a tab of its own, which is what the card is dropped onto.
 *
 * Anywhere outside a group is a destination, and this is the one that is reliably **beside** the
 * group: an ungrouped card is a direct child of the grid, so it sits in the next column. The
 * heading was tried and is the wrong choice here, not because the product refuses it but because
 * the heading and the card end up 646 apart, which was more than the window had. The window is
 * grown to fit the list below, which is the general answer to the same problem.
 */
const alone = await openTerminal();
await waitFor(alone.client, "document.querySelector('.launcher-input')");
await type(alone.client, 'echo DRAG-ALONE\r');
await sleep(1500);

// Read from another tab, so this is about somebody else's tab, which is the real case.
const viewer = await openTerminal();
await waitFor(viewer.client, "document.querySelector('.launcher-input')");
await sleep(2000);

/**
 * A window tall enough for the whole list, measured rather than guessed.
 *
 * A drag needs both ends on screen at once, and how far apart they are is decided by how many
 * sessions other suites happen to have running: alone there are three cards and they are
 * neighbours, in a full run there were eight and the two ends were five hundred and fifty nine
 * pixels apart in a window four hundred and sixty nine tall. The suite then reported that the
 * product could not be dragged, which was a fact about the machine.
 *
 * So the window is grown to fit what is actually on the list. Headless gives each tab a window of
 * its own, so this reaches nothing else.
 */
const { windowId } = await viewer.client.send('Browser.getWindowForTarget');
const needed = Number(
  await evaluate(
    viewer.client,
    `(() => {
       const grid = document.querySelector('.session-grid');
       const body = document.querySelector('.launcher-body');
       if (!grid) return 0;
       return Math.round(grid.scrollHeight + (body ? body.scrollTop : 0));
     })()`,
  ),
);
await viewer.client.send('Browser.setWindowBounds', {
  windowId,
  bounds: { width: 1200, height: Math.max(700, Math.min(2000, needed + 420)) },
});
await sleep(900);

/*
 * Counted for **this** tab, not for the page.
 *
 * Suites share a daemon and run three at a time, so this list carries other suites' terminals and
 * one of them is also drawing groups. Every count here names the workspace it is about.
 */
const mine = String(await evaluate(work.client, 'window.__tabterm.workspaceId()'));
/*
 * A tab is a wash behind its cards now, and the cards are members of the one grid tagged with the
 * tab they belong to. Nothing is nested, which is what keeps every card on the same pitch.
 */
const group = `.session-wash[data-workspace-id="${mine}"]`;
const inGroup = `.session-card[data-group="${mine}"]`;

/*
 * The sessions this suite made, so "is it still on the list" is a question about them.
 *
 * Several suites add to and take from this list the whole time, so counting every card on it
 * answered whatever else happened to be finishing at that moment.
 */
const ourSessions = JSON.parse(
  String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneSessions())')),
).map((pane) => pane.sessionId);

const shape = async () =>
  JSON.parse(
    String(
      await evaluate(
        viewer.client,
        `JSON.stringify({
           groups: document.querySelectorAll('${group}').length,
           inGroups: document.querySelectorAll('${inGroup}').length,
           // This suite's own sessions, not every card on a list several suites are adding to
           // and taking from. Counting all of them made "is it still on the list" a question
           // about whatever else was finishing at that moment.
           cards: document.querySelectorAll('.session-card').length,
           mine: ${JSON.stringify(ourSessions)}.filter((id) =>
             document.querySelector('.session-card[data-session-id="' + id + '"]') !== null).length,
           landed: document.querySelectorAll('.session-card.is-landed').length,
         })`,
      ),
    ),
  );

const strip = async () =>
  JSON.parse(
    String(
      await evaluate(
        viewer.client,
        `new Promise((done) => chrome.tabs.query({}, (tabs) => done(JSON.stringify(
           tabs.filter((t) => (t.url ?? '').includes('terminal.html'))
               .map((t) => ({
                 index: t.index,
                 active: t.active,
                 workspace: new URL(t.url).searchParams.get('workspace'),
               }))))))`,
      ),
    ),
  );

const grouped = await waitUntil(async () => (await shape()).inGroups >= 2, 20000);
r.ok('the two panes of one tab are drawn as one group', grouped, JSON.stringify(await shape()));

/*
 * A drop on another group is refused.
 *
 * Out of a tab is the only thing this gesture does. Dragging one card onto the group it is already
 * in is the nearest thing to an accident available, so that is the one tried here: nothing may
 * move, and in particular nothing may be detached and then put back.
 */
const before = await shape();
const ontoItself = await dragOnto(viewer.client, `${inGroup}`, group);
r.ok('a card in a group can be picked up at all', ontoItself === '', ontoItself);
await sleep(1500);
const afterRefused = await shape();
r.ok(
  'and dropping it back onto a group changes nothing',
  afterRefused.inGroups === before.inGroups && afterRefused.groups === before.groups,
  `${JSON.stringify(before)} -> ${JSON.stringify(afterRefused)}`,
);

/*
 * And out, onto the heading above the list, which is the space beside the cards rather than
 * another card. "Anywhere that is not a group" is the rule, so the test drops somewhere that is
 * not a card either.
 */
const url = String(await evaluate(viewer.client, 'location.href'));
const tabsBefore = new Set((await strip()).map((t) => t.workspace));
const moved = await dragOnto(viewer.client, `${inGroup}`, '.session-card:not([data-group])');
r.ok('the card can be dragged out of its group', moved === '', moved);

const left = await waitUntil(async () => (await shape()).inGroups < before.inGroups, 25000);
r.ok(
  'the session leaves the tab it was sharing',
  left,
  `${JSON.stringify(before)} -> ${JSON.stringify(await shape())}`,
);

/*
 * Still on the list, as its own card. It was moved, not closed, and the whole list is how somebody
 * finds a terminal they left running.
 */
const now = await shape();
r.ok('and is still on the list, on its own', now.mine >= before.mine, JSON.stringify(now));

/*
 * And the tab it left has one pane, so there is no group left to draw. A group of one is a box
 * drawn around a single card saying "1 pane in one tab", which says nothing.
 */
r.ok(
  'the group it came out of is gone, having one pane left',
  now.groups === 0,
  JSON.stringify(now),
);

/*
 * The person is left where they were.
 *
 * This page is the start screen and they are in the middle of using it. The new tab exists in the
 * strip; taking them to it would answer a request they did not make.
 */
r.ok(
  'and this tab has not gone anywhere',
  String(await evaluate(viewer.client, 'location.href')) === url,
  url,
);

/*
 * A tab for it exists, beside the one it came out of, and not in front of anybody.
 *
 * Asked of Chrome, because that is where the answer is. Beside rather than at the end of the strip:
 * at the end it reads as an unrelated tab that happened to appear, and what happened is that this
 * one moved. Not active, because the person is on the start screen doing something else.
 */
const tabs = await strip();
const source = String(await evaluate(work.client, 'window.__tabterm.workspaceId()'));
/*
 * The tab that appeared, found by difference rather than by elimination. Other suites have tabs
 * open in this browser, so "the one that is not ours" names one of theirs.
 */
const opened = tabs.find((t) => t.workspace !== null && !tabsBefore.has(t.workspace));
r.ok('a tab was opened for the session that moved', opened !== undefined, JSON.stringify(tabs));

const from = tabs.find((t) => t.workspace === source);
r.ok(
  'and it sits next to the tab it came out of',
  opened !== undefined && from !== undefined && opened.index === from.index + 1,
  JSON.stringify(tabs),
);

r.ok(
  'and was not put in front of the person',
  opened !== undefined && opened.active === false,
  JSON.stringify(tabs),
);

await finish();
r.done();
