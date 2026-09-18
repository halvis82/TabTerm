// The list comes back to the shape it had when the window comes back to the width it had.
//
// Reported after zooming out and back in: "when i zoom out and then zoom in again the view in the
// running now gets a little weird", with the cards narrower than they should be and the right hand
// column running off the side of the page, until the tab was refreshed.
//
// Zoom is a width change as far as layout is concerned, which is what this does: the viewport is
// widened, the packing follows it, and then it is put back. The list must be exactly what it was,
// and nothing may hang off the side, which he has asked for twice: no horizontal scrolling, ever.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

// A tab of two panes, so the list has a group in it. A group is the part that spans columns, and
// spanning is where a column that is no longer there does the most damage.
const work = await openTerminal();
await waitFor(work.client, "document.querySelector('.launcher-input')");
await type(work.client, 'echo RESIZE-ONE\r');
await waitFor(work.client, `(window.__tabterm.readScreen() ?? '').includes('RESIZE-ONE')`, 20000);
await evaluate(work.client, "window.__tabterm.split('horizontal')");
await waitFor(work.client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1200);
const [, second] = JSON.parse(
  String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneIds())')),
);
await evaluate(work.client, `window.__tabterm.focus(${JSON.stringify(second)})`);
await sleep(400);
await type(work.client, 'echo RESIZE-TWO\r');
await sleep(1200);

// And a third tab to read the list from, so it is a list of other people's sessions.
const viewer = await openTerminal();
await waitFor(viewer.client, "document.querySelector('.launcher-input')");
await waitUntil(
  async () =>
    Number(await evaluate(viewer.client, `document.querySelectorAll('.session-card').length`)) >= 2,
  20000,
);

/**
 * The shape of the list: how many columns it has, where every tile sits, and whether any of it is
 * off the side.
 *
 * The places are read from the style rather than from the boxes on screen, because that is what
 * the packing decides and what a column that has gone would leave behind.
 */
const shape = async () =>
  JSON.parse(
    String(
      await evaluate(
        viewer.client,
        `(() => {
           const grid = document.querySelector('.session-grid');
           if (!grid) return JSON.stringify({ columns: 0, places: [], over: 0 });
           const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
           const places = [...grid.children]
             .filter((el) => el.dataset.tile !== undefined)
             .map((el) => (el.style.gridColumn || '') + '@' + (el.style.gridRow || ''));
           return JSON.stringify({
             columns: tracks.length,
             places,
             over: grid.scrollWidth - grid.clientWidth,
           });
         })()`,
      ),
    ),
  );

/**
 * Chrome's own zoom, which is what he used. Not an emulated viewport: zoom changes the number of
 * CSS pixels the window has **and** the ratio it draws them at, and a check that only moved the
 * viewport passed while the thing he reported still happened.
 */
const zoomTo = async (level) => {
  await evaluate(
    viewer.client,
    `new Promise((done) => chrome.tabs.getCurrent((t) =>
       chrome.tabs.setZoom(t.id, ${String(level)}, () => done('ok'))))`,
  );
  await sleep(900);
};

await zoomTo(1);
await sleep(1200);
const before = await shape();
r.ok('the list is packed into the window it has', before.columns >= 2, JSON.stringify(before));
r.ok('and nothing hangs off the side of it', before.over <= 1, `${String(before.over)}px over`);

// Zoomed out, which is more CSS pixels across. The packing follows it, or there is nothing to
// put back.
await zoomTo(0.75);
const grew = await waitUntil(async () => (await shape()).columns > before.columns, 8000);
r.ok('a wider window gives the list more columns', grew, JSON.stringify(await shape()));

// And back to where it was, which is the half that was reported.
await zoomTo(1);
const back = await waitUntil(async () => (await shape()).columns === before.columns, 8000);
const after = await shape();
r.ok(
  'and the window put back gives the columns back',
  back,
  `${String(before.columns)} -> ${String(after.columns)}`,
);
/*
 * And every tile is inside the grid, which is the invariant rather than the exact arrangement.
 *
 * Comparing the places to the ones taken before the window moved read well and was not a fact
 * about this: suites share a machine, sessions come and go in other tabs the whole time, and the
 * list is rebuilt whenever one does. What must be true whatever is on the list is that nothing is
 * placed in a column the window does not have, because that is what makes the column.
 */
const outside = after.places.filter((place) => {
  const [start, span] = place
    .split('@')[0]
    .split('/')
    .map((n) => Number(n.replace(/\D+/g, '')));
  return Number.isFinite(start) && start + (Number.isFinite(span) ? span : 1) - 1 > after.columns;
});
r.ok(
  'and every tile is inside the columns it has',
  outside.length === 0,
  `${String(after.columns)} columns, ${JSON.stringify(outside)}`,
);
r.ok('and still nothing hangs off the side', after.over <= 1, `${String(after.over)}px over`);

/*
 * And the half that was actually reported: the zoom happened while this tab was in the background.
 *
 * Chrome's zoom is per origin, so zooming any TabTerm tab zooms every other one, including the
 * start screens nobody is looking at. A hidden tab runs no resize observer, so the width it was
 * packed for can change twice while it is away and come back to the same number, and the observer
 * then has nothing to report. What is left is a list packed for a window that is not there.
 */
const viewerTab = Number(
  await evaluate(viewer.client, `new Promise((done) => chrome.tabs.getCurrent((t) => done(t.id)))`),
);
const fresh = await shape();

await work.client.send('Page.bringToFront');
await sleep(500);
await evaluate(
  work.client,
  `new Promise((done) => chrome.tabs.setZoom(${String(viewerTab)}, 0.67, () => done('ok')))`,
);
await sleep(700);

/*
 * And something rebuilds the list while it is away, which is what puts the wrong width into it: a
 * session starting anywhere announces the list to every start screen open on the machine.
 */
const cardsNow = Number(
  await evaluate(viewer.client, `document.querySelectorAll('.session-card').length`),
);
const newcomer = await openTerminal();
await waitFor(newcomer.client, "document.querySelector('.launcher-input')");
await type(newcomer.client, 'echo RESIZE-THREE\r');
await work.client.send('Page.bringToFront');
await waitUntil(
  async () =>
    Number(await evaluate(viewer.client, `document.querySelectorAll('.session-card').length`)) >
    cardsNow,
  25000,
);

/*
 * Read the moment it has been rebuilt, and while it is still hidden.
 *
 * A hidden tab runs no animation frames and Chrome slows its timers to a second and eventually to
 * a minute, so a list that waits for either spends that long with its cards wherever the browser
 * put them and no colour behind the tabs at all. Which is exactly what a full run caught: a wash
 * with no outline in it, in the one suite whose tabs are hidden by other suites running beside it.
 */
const whileHidden = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const wash = document.querySelector('.session-wash');
         return JSON.stringify({
           state: document.visibilityState,
           washes: document.querySelectorAll('.session-wash').length,
           drawn: (wash?.querySelector('path.session-wash-edge')?.getAttribute('d') ?? '').length,
           packed: document.querySelector('.session-grid')?.dataset.columns ?? '-',
         });
       })()`,
    ),
  ),
);
r.ok(
  'a list rebuilt while its tab is hidden is packed there and then',
  whileHidden.washes >= 1 && whileHidden.drawn > 0,
  JSON.stringify(whileHidden),
);

await evaluate(
  work.client,
  `new Promise((done) => chrome.tabs.setZoom(${String(viewerTab)}, 1, () => done('ok')))`,
);
await sleep(700);
await viewer.client.send('Page.bringToFront');
await sleep(1200);

const returned = await shape();
r.ok(
  'a list packed while its tab was hidden is put right when the tab comes back',
  returned.columns === fresh.columns,
  `${String(fresh.columns)} -> ${String(returned.columns)}`,
);
r.ok(
  'and nothing hangs off the side of it either',
  returned.over <= 1,
  `${String(returned.over)}px over`,
);

/*
 * And the reason it never came back on its own, which is worth a check of its own.
 *
 * A place in a column that is not there **makes** that column. Chrome reports the implicit tracks
 * along with the real ones, so a grid of three that has something sitting in the fifth column says
 * it has five, and the next pack believes it: the cards are squeezed to their minimum, the list
 * runs off the side, and every pack after that agrees with the last one. Only a reload broke it.
 *
 * Forced here rather than waited for, because the state is what matters and there are several ways
 * into it: a pack at a width the window no longer has is only the commonest.
 */
const wrecked = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const grid = document.querySelector('.session-grid');
         const item = grid?.querySelector('[data-tile]');
         if (!grid || !item) return 'null';
         const before = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
         item.style.gridColumn = String(before + 3) + ' / span 1';
         return JSON.stringify({
           before,
           after: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
         });
       })()`,
    ),
  ),
);
r.ok(
  'a place in a column that is not there makes the grid claim to have one',
  wrecked !== null && wrecked.after > wrecked.before,
  JSON.stringify(wrecked),
);

// Anything that packs again must now undo it rather than build on it.
await viewer.client.send('Page.bringToFront');
await evaluate(viewer.client, `document.dispatchEvent(new Event('visibilitychange')) || 'sent'`);
await sleep(600);
const repaired = await shape();
r.ok(
  'and the next packing puts the list back inside the window',
  repaired.columns === fresh.columns && repaired.over <= 1,
  `${String(repaired.columns)} columns, ${String(repaired.over)}px over`,
);
/*
 * And it packed for the window rather than for the column it had just been told about. Asked of
 * the grid directly, because with few enough cards to fit in one row either way the positions look
 * the same whichever number was used, and the number is the fault.
 */
const packedFor = Number(
  await evaluate(viewer.client, `document.querySelector('.session-grid')?.dataset.columns ?? -1`),
);
r.ok(
  'and it packed for the columns the window has',
  packedFor === fresh.columns,
  `packed for ${String(packedFor)}, the window has ${String(fresh.columns)}`,
);

await finish();
r.done();
