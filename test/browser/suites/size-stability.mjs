// A terminal changes size when a person changes it, and at no other time.
//
// The question this was written for, asked plainly: a session lives in a Chrome tab, and Chrome
// does things to tabs that nobody asked for. It hides them, it takes their GPU contexts away and
// gives them back, it freezes them, it restores them from the back/forward cache. None of that is
// a person deciding a terminal should be a different width, so none of it may move one.
//
// It matters more than it sounds. The accelerated renderer and the DOM one disagree about how wide
// a character is, 7.5 pixels against 7.83, which is 195 columns against 187 for the same box. So
// handing a context back and taking it again is, by itself, enough to produce two size changes for
// a window nobody touched. A shell survives that. An agent redraws its entire interface on a
// resize, and two of them inside a second is the scrambled output this whole area exists to stop.
//
// The shape of the check: do human things, note where everything settled, then spend half a minute
// doing only things the *system* does, and assert that nothing whatsoever moved.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  newTab,
} from '../helpers.mjs';
import { reporter, closeTab, activateTab } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

/** Grid, daemon size, how many times the grid moved, and every size ever asked for. */
const state = async () =>
  JSON.parse(
    String(
      await evaluate(
        client,
        `JSON.stringify(window.__tabterm.paneIds().map((id) => ({
           id,
           grid: window.__tabterm.gridOf(id),
           daemon: window.__tabterm.daemonSizeFor(id),
           moves: window.__tabterm.gridMovesFor(id),
           asks: window.__tabterm.sizeAsksFor(id),
           webgl: window.__tabterm.rendererAttachedFor(id),
         })))`,
      ),
    ),
  );

const agree = (p) =>
  p.daemon === null || (p.grid.cols === p.daemon.cols && p.grid.rows === p.daemon.rows);

// Human things, which are allowed to change a size.
await type(client, 'echo size-stability\r');
await sleep(1200);
await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(3000);

await waitUntil(async () => (await state()).every(agree), 15000);
const settled = await state();
r.ok(
  'two panes, settled and agreeing with the daemon',
  settled.length === 2 && settled.every(agree),
  JSON.stringify(settled.map((p) => ({ grid: p.grid, daemon: p.daemon }))),
);

/** Everything the system is allowed to do to a tab, and the record of what it cost. */
const before = settled;
const askCount = (s) => s.reduce((n, p) => n + p.asks.length, 0);
const movesBefore = before.map((p) => p.moves);

/*
 * 1. The tab is hidden, long enough that the renderers are handed back.
 *
 * Really hidden, by putting another tab in front of it, because `document.visibilityState` is read
 * inside the code being checked and a synthetic event does not change what the browser reports.
 * Six seconds because the handback is at four, so this is the window where a pane is drawing with
 * the DOM renderer and a cell is suddenly 7.83 wide instead of 7.5.
 */
const other = await newTab('about:blank');
/*
 * Asked more than once, because asking once is not reliable under a loaded machine.
 *
 * Activating a tab is a request to a browser that is busy doing other things, and in a full run
 * it does not always take the first time. Retrying is not papering over a product fault: nothing
 * in TabTerm decides which tab a browser puts in front, and the state being set up here is the
 * precondition for the check rather than the thing being checked.
 */
let wentHidden = false;
for (let attempt = 0; attempt < 4 && !wentHidden; attempt++) {
  await activateTab(other.id);
  wentHidden = (await waitFor(client, `document.visibilityState === 'hidden'`, 6000)) === true;
}
/*
 * And asserted rather than assumed.
 *
 * `document.visibilityState` is read inside the code being checked, so a check about a hidden tab
 * that did not manage to hide one would pass everything below for the wrong reason.
 */
r.ok(
  'the tab really is hidden, which is what the browser reads and no harness can fake',
  wentHidden,
  String(await evaluate(client, 'document.visibilityState')),
);

/*
 * Counted rather than sampled, and waited for rather than slept through.
 *
 * The handback is on a timer, so a fixed sleep races it on a loaded machine. And whether a pane
 * has a renderer *right now* is the wrong question: a tab can hand one back and be given another
 * between two polls, which is what a full run actually produced, reported as `visibility hidden,
 * renderers [true,true]`. The count cannot come back down.
 */
const handbacks = async () =>
  Number(await evaluate(client, 'window.__tabterm.rendererHandbacksForTest()'));
const releases = async () =>
  JSON.parse(
    String(
      await evaluate(
        client,
        'JSON.stringify(window.__tabterm.paneIds().map((id) => window.__tabterm.rendererReleasesFor(id)))',
      ),
    ),
  );
const handbacksBefore = await handbacks();
/*
 * And told the memory mode throughout, which is what a busy daemon does.
 *
 * It broadcasts that to every open tab on any settings change and on a reset, and the page
 * schedules a handback each time it hears it while hidden. Restarting the timer on every message
 * meant a tab told often enough never handed anything back: measured in a full run at 205
 * schedules and zero handbacks. Nothing here is synthetic except the messenger, and the page
 * cannot tell the difference.
 */
const nagging = setInterval(() => {
  void evaluate(client, 'window.__tabterm.scheduleRendererReleaseForTest()');
}, 700);
const wasReleased = await waitUntil(async () => (await handbacks()) > handbacksBefore, 25000);
clearInterval(nagging);
r.ok(
  'the hidden tab handed its renderers back, so this is the case it exists for',
  wasReleased,
  `visibility ${String(await evaluate(client, 'document.visibilityState'))}, handbacks ${String(handbacksBefore)} -> ${String(await handbacks())}, scheduled ${String(await evaluate(client, 'window.__tabterm.rendererHandbacksScheduledForTest()'))}, per pane ${JSON.stringify(await releases())}, frozen ${String(await evaluate(client, 'String(document.wasDiscarded) + " " + String(navigator.userActivation?.isActive)'))}`,
);

// 2. And it comes back, which is when the context is asked for again and the cell changes back.
await closeTab(other.id);
r.ok(
  'and the tab is looked at again',
  (await waitFor(client, `document.visibilityState === 'visible'`, 20000)) === true,
  String(await evaluate(client, 'document.visibilityState')),
);
await sleep(2500);
await waitUntil(async () => (await state()).every(agree), 20000);

const after = await state();

/*
 * The assertion the question deserves: not "it ended up right", but "it never moved".
 *
 * An end state that matches proves nothing here, because a size that goes away and comes back
 * matches at both ends. What is asserted is the count of requests and the count of grid moves,
 * neither of which can come back down.
 */
/*
 * A repeated size is not a resize. A different one is.
 *
 * The daemon drops a request that matches the size a session is already running at before any
 * signal reaches the program, so re-stating a size costs a message and nothing else. What may
 * never happen is the system proposing a size nobody asked for, because that one does reach the
 * program, and a program redrawing in place cannot survive it.
 */
const newAsks = after.flatMap((p) => {
  const was = before.find((b) => b.id === p.id);
  return p.asks.slice(was?.asks.length ?? 0).map((a) => ({
    ...a,
    want: `${String(a.cols)}x${String(a.rows)}`,
    had: `${String(was?.grid.cols ?? 0)}x${String(was?.grid.rows ?? 0)}`,
  }));
});
r.ok(
  'hiding the tab and coming back proposed no size the panes did not already have',
  newAsks.every((a) => a.want === a.had),
  JSON.stringify(newAsks.map((a) => `${a.why} wanted ${a.want}, had ${a.had}`)),
);
r.ok(
  'and moved no pane grid',
  after.every((p, i) => p.moves === movesBefore[i]),
  `${JSON.stringify(movesBefore)} -> ${JSON.stringify(after.map((p) => p.moves))}`,
);
r.ok(
  'and every pane is on the grid it was on before',
  after.every((p) => {
    const was = before.find((b) => b.id === p.id);
    return was && p.grid.cols === was.grid.cols && p.grid.rows === was.grid.rows;
  }),
  `${JSON.stringify(before.map((p) => p.grid))} -> ${JSON.stringify(after.map((p) => p.grid))}`,
);
/*
 * Waited for, because a renderer arriving is the one thing in this sequence that legitimately
 * asks for a size. It is the correction point: the cell is now the one this pane will keep, so
 * the measurement taken then is the one worth having. Under load it arrives later, and a check
 * that had already started counting a quiet period counted that as the system moving something.
 */
const cameBack = await waitUntil(async () => (await state()).every((p) => p.webgl), 25000);
r.ok('and the renderers came back', cameBack, JSON.stringify(after.map((p) => p.webgl)));

/*
 * 3. And nothing changed and changed back anywhere in the whole run.
 *
 * The other shape the fault takes. A pane can end where it started having visited a different size
 * in between, and a count taken at two points cannot see it. This reads the sequence.
 */
const oscillations = [];
for (const p of after) {
  const seq = p.asks.map((a) => `${String(a.cols)}x${String(a.rows)}`);
  for (let i = 2; i < seq.length; i++) {
    if (seq[i] === seq[i - 2] && seq[i] !== seq[i - 1]) {
      oscillations.push(
        `${p.id.slice(0, 6)}: ${seq[i - 2]} -> ${seq[i - 1]} -> ${seq[i]} (${p.asks[i - 1].why})`,
      );
    }
  }
}
r.ok(
  'and no pane was asked for a size, then another, then the first one again',
  oscillations.length === 0,
  JSON.stringify(oscillations),
);

/*
 * 4. The tab left alone, which is the plainest form of the question.
 *
 * Ten seconds of nothing at all. Longer than the settle, longer than the handback, long enough
 * that anything on a timer has fired.
 */
/*
 * Settled first, and settled means "nothing has asked for a size for a while" rather than a
 * duration. Everything above is allowed to produce one last correction as a renderer arrives;
 * what is being asserted here is that once the dust is down, nothing starts it up again.
 */
let lastCount = -1;
let stableFor = 0;
const STABLE_POLLS = 16; // waitUntil polls every 150ms, so about two and a half seconds of quiet.
await waitUntil(async () => {
  const now = askCount(await state());
  stableFor = now === lastCount ? stableFor + 1 : 0;
  lastCount = now;
  return stableFor >= STABLE_POLLS;
}, 25000);

const quietFrom = await state();
await sleep(10000);
const quiet = await state();
r.ok(
  'a tab nobody is touching asks for nothing at all',
  askCount(quiet) === askCount(quietFrom),
  `${String(askCount(quietFrom))} -> ${String(askCount(quiet))}`,
);
r.ok(
  'and its panes stay exactly where they are',
  quiet.every((p, i) => p.moves === quietFrom[i].moves),
  `${JSON.stringify(quietFrom.map((p) => p.moves))} -> ${JSON.stringify(quiet.map((p) => p.moves))}`,
);
r.ok(
  'and still agrees with the daemon at the end of it',
  quiet.every(agree),
  JSON.stringify(quiet.map((p) => ({ grid: p.grid, daemon: p.daemon }))),
);

/*
 * 5. A pane that has no renderer, and is waiting for one.
 *
 * The state the sizing rules exist for, and the only one a check can put a browser into
 * deliberately: contexts are capped and a hidden tab hands its own back, so a pane measuring with
 * a cell it is about to replace is ordinary rather than exotic. What it measures then is a
 * different number for the same box, 187 where the settled answer is 195, and asking for it
 * resizes a program that is drawing in place.
 *
 * So while it waits it asks for nothing. Not the daemon, and not its own grid either.
 */
await evaluate(client, 'window.__tabterm.blockRendererForTest(true)');
await sleep(500);
const blockedFrom = await state();
r.ok(
  'every pane is now without a renderer, waiting for one',
  blockedFrom.every((p) => !p.webgl),
  JSON.stringify(blockedFrom.map((p) => p.webgl)),
);

// Every moment that makes a tab measure itself again, with no renderer to measure against.
await evaluate(client, 'window.dispatchEvent(new Event("focus"))');
await sleep(800);
await evaluate(client, 'window.dispatchEvent(new Event("pageshow"))');
await sleep(2500);

const blocked = await state();
r.ok(
  'a pane waiting for a renderer asks for no size at all',
  askCount(blocked) === askCount(blockedFrom),
  `${String(askCount(blockedFrom))} -> ${String(askCount(blocked))}: ${JSON.stringify(
    blocked.flatMap((p) => {
      const was = blockedFrom.find((b) => b.id === p.id);
      return p.asks
        .slice(was?.asks.length ?? 0)
        .map((a) => `${a.why} ${String(a.cols)}x${String(a.rows)}`);
    }),
  )}`,
);
r.ok(
  'and does not move its own grid either',
  blocked.every((p, i) => p.moves === blockedFrom[i].moves),
  `${JSON.stringify(blockedFrom.map((p) => p.moves))} -> ${JSON.stringify(blocked.map((p) => p.moves))}`,
);
r.ok(
  'and still agrees with the daemon while it waits',
  blocked.every(agree),
  JSON.stringify(blocked.map((p) => ({ grid: p.grid, daemon: p.daemon }))),
);

// And when one arrives, it measures again and the two agree, which is the correction point.
await evaluate(client, 'window.__tabterm.blockRendererForTest(false)');
await sleep(2500);
await waitUntil(async () => (await state()).every(agree), 15000);
const recovered = await state();
r.ok(
  'and once a renderer arrives the pane is believed again',
  recovered.every((p) => p.webgl) && recovered.every(agree),
  JSON.stringify(recovered.map((p) => ({ webgl: p.webgl, grid: p.grid, daemon: p.daemon }))),
);

await finish();
r.done();
