// Reattaching a split tab must not tell a narrow pane it is as wide as the tab.
//
// The attach used to carry one size, measured from the first pane, and the daemon applied it to
// every session in the workspace. A 41 column pane was told it was 124 and corrected a moment
// later. A shell survives that. An agent redraws its whole interface on a resize, so it drew at
// the wrong width, drew again at the right one, and left the first frame stranded between the
// lines of the second. That is the scrambled output that made an agent unusable.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo attach-sizes\r');
await sleep(1200);

// Two panes of very different widths, which is the case one number cannot describe.
await evaluate(client, "window.__tabterm.split('horizontal')");
await sleep(3000);
await waitFor(client, 'window.__tabterm.paneIds().length === 2');
await sleep(1500);

/** What each pane's terminal believes its grid is. */
const grids = async () =>
  JSON.parse(
    String(
      await evaluate(
        client,
        `JSON.stringify(window.__tabterm.paneIds().map((id) => {
           const t = window.__tabterm.gridOf(id);
           return { id, cols: t?.cols ?? 0, rows: t?.rows ?? 0 };
         }))`,
      ),
    ),
  );

/**
 * Dragged well off centre first, which is what makes this a check.
 *
 * An even split is the one arrangement a single size describes correctly, so a tab left at 50/50
 * passes whether or not each pane is given its own size. The fault only shows when the panes are
 * different widths, which is the ordinary case on a real screen and has to be the case here.
 */
{
  const box = JSON.parse(
    String(
      await evaluate(
        client,
        `(() => { const d = document.querySelector('.divider'); if (!d) return 'null';
           const b = d.getBoundingClientRect();
           return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }); })()`,
      ),
    ),
  );
  if (box) {
    const to = Math.round(box.x * 0.35);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: to,
      y: box.y,
      button: 'left',
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(1500);
  }
}

const before = await grids();
r.ok('two panes to begin with', before.length === 2, JSON.stringify(before));
r.ok(
  'and they are different widths, which is what one number cannot describe',
  before.length === 2 && Math.abs(before[0].cols - before[1].cols) > 4,
  JSON.stringify(before),
);

/*
 * The reattach, which is what a refresh, a wake and a daemon restart all are.
 *
 * The property is not that the panes differ in width, which depends on how the window happens to
 * be split. It is that **reattaching does not change any pane's size**. The fault was a pane being
 * told it was as wide as the whole tab and corrected a moment later, and an agent redraws its
 * whole interface for each of those.
 */
await client.send('Page.reload');
await waitFor(client, 'window.__tabterm?.paneIds().length === 2', 25000);
await sleep(2500);

const after = await grids();
const sizeOf = (list, id) => list.find((p) => p.id === id);
const moved = before.filter((b) => {
  const a = sizeOf(after, b.id);
  return !a || Math.abs(a.cols - b.cols) > 1 || Math.abs(a.rows - b.rows) > 1;
});
r.ok(
  'every pane comes back on the grid it was on',
  moved.length === 0,
  `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
);
r.ok(
  'and no pane was widened toward the size of the whole tab',
  after.every((a) => a.cols <= Math.max(...before.map((b) => b.cols)) + 1),
  JSON.stringify(after),
);

/**
 * And each pane's grid settled without being moved twice, which is the fault itself.
 *
 * The end state is right either way: a pane told it is as wide as the whole tab is corrected a
 * moment later and ends up correct. What the fault costs is the redraw in between, and an agent
 * redraws its entire interface for every one of them, leaving the earlier frame stranded in the
 * scrollback. So the count is what is asserted, not the size.
 */
const moves = JSON.parse(
  String(
    await evaluate(
      client,
      `JSON.stringify(window.__tabterm.paneIds().map((id) => ({ id, moves: window.__tabterm.gridMovesFor(id) })))`,
    ),
  ),
);
r.ok(
  'and settled on it without being moved twice',
  moves.every((m) => m.moves <= 1),
  JSON.stringify(moves),
);

/**
 * And the attach itself carried a size per pane, which is the fix.
 *
 * Whether the wrong size is actually applied depends on whether the renderer was ready enough for
 * the page's measurement to be believed, which is not a thing this harness reliably reproduces.
 * What the attach claimed does not depend on any of that: one number cannot describe two panes of
 * different widths, and it used to be all the daemon was given.
 */
/*
 * Measured on a reconnect rather than on the reload above.
 *
 * A page that has just loaded has no panes yet: the layout arrives in the answer to the attach, so
 * there is nothing to measure and it correctly sends one number marked as a guess, which the
 * daemon refuses to apply to a session that already has a size. A reconnect is the case where the
 * page does have panes, does send a measurement, and used to send one for all of them.
 */
await evaluate(client, 'window.__tabterm.loseConnection()');
await waitFor(client, `JSON.parse(window.__tabterm.transport()).status === 'ready'`, 25000);
await sleep(1500);
const claimed = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.lastAttachForTest())')),
);
r.ok(
  'the attach carried a size for every pane',
  claimed.panes.length === after.length,
  JSON.stringify(claimed),
);
r.ok(
  'and those sizes are the panes own, not one number repeated',
  new Set(claimed.panes.map((p) => p.cols)).size > 1,
  JSON.stringify(claimed.panes),
);

/*
 * And the daemon agrees, which is the half that reaches the program.
 *
 * A pane whose terminal says 41 while the session runs at 124 is a program drawing into a grid
 * nobody is showing it, which is what a resize storm leaves behind.
 */
const applied = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(JSON.parse(window.__tabterm.transport()).panes)')),
);
r.ok('the daemon has a stream for each pane', applied.length === 2, JSON.stringify(applied));

await finish();
r.done();
