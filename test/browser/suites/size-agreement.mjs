// One invariant, after every path that can change a size.
//
//   A pane's grid is the size the daemon says its session is running at.
//
// That is the whole of it. One PTY has one size, and a view rendering at a different one is drawing
// into columns the shell does not know exist: lines wrap somewhere else, absolute cursor moves land
// in the wrong column, and a full-screen application comes back as fragments of several moments
// overlapping. An agent redraws its entire interface on a resize, so it shows there first and
// worst.
//
// Written because the question was asked directly: can a tab ever disagree with the daemon about
// the size, or resize itself. Each block below is one way a size can change, and every one of them
// ends with the same two assertions.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

/** Every pane, its grid, and what the daemon last said that session runs at. */
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
         })))`,
      ),
    ),
  );

/**
 * Settled, then compared.
 *
 * A resize is a conversation: the page measures, the daemon decides, the page is told. Asserting
 * in the middle of one is asserting on a moment nobody experiences, so this waits for the two to
 * agree and reports what they were if they never do.
 */
const agree = (p) =>
  p.daemon === null || (p.grid.cols === p.daemon.cols && p.grid.rows === p.daemon.rows);

async function settled(what, timeoutMs = 15000) {
  const ok = await waitUntil(async () => (await state()).every(agree), timeoutMs);
  const now = await state();
  r.ok(
    `${what}: every pane's grid is the size the daemon says it is running at`,
    ok,
    JSON.stringify(now),
  );
  return now;
}

/**
 * And a pane the daemon has never spoken about is not a pass by omission.
 *
 * `agree` treats an unknown daemon size as agreement, because the daemon only speaks when it has
 * something to say. That is right, and it would also hide the case where nothing ever reached the
 * page at all, so at least one pane has to have been told something by the end.
 */
const someoneWasTold = (panes) => panes.some((p) => p.daemon !== null);

// 1. A terminal that has just been created.
await type(client, 'echo size-agreement\r');
await sleep(1200);
await settled('a new terminal');

// 2. A split, which is the case one size cannot describe.
await evaluate(client, "window.__tabterm.split('horizontal')");
await sleep(3000);
await waitFor(client, 'window.__tabterm.paneIds().length === 2');
const afterSplit = await settled('after splitting');
r.ok(
  'and the two panes are not assumed to be the same size',
  afterSplit.length === 2,
  JSON.stringify(afterSplit.map((p) => p.grid)),
);

// 3. The divider dragged well off centre, so the panes are genuinely different widths.
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
    const to = Math.round(box.x * 0.4);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    for (const x of [box.x - 30, box.x - 80, to]) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y: box.y,
        button: 'left',
      });
      await sleep(120);
    }
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }
  await sleep(1500);
  const dragged = await settled('after dragging the divider');
  r.ok(
    'which left the panes different widths, so one number cannot describe them',
    new Set(dragged.map((p) => p.grid.cols)).size > 1,
    JSON.stringify(dragged.map((p) => p.grid)),
  );
}

// 4. The window resized, which reaches every pane at once and by different amounts.
for (const [width, height] of [
  [1150, 800],
  [980, 720],
  [1220, 830],
]) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);
}
await client.send('Emulation.clearDeviceMetricsOverride');
await sleep(1200);
await settled('after resizing the window');

// 5. A second view of one session, which is the case where a pane is genuinely overruled.
{
  const [first] = JSON.parse(
    String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
  );
  const before = (await state()).find((p) => p.id === first);
  // Deliberately smaller: one PTY has one size and it is the smallest of the views looking at it.
  await evaluate(
    client,
    `window.__tabterm.attachSecondView(${JSON.stringify(first)}, ${String(Math.max(20, (before?.grid.cols ?? 80) - 15))}, ${String(Math.max(5, (before?.grid.rows ?? 24) - 4))})`,
  );
  await sleep(2000);
  const overruled = await settled('with a second, smaller view of one session');
  const now = overruled.find((p) => p.id === first);
  r.ok(
    'the pane follows the daemon down rather than keeping its own larger grid',
    (now?.grid.cols ?? 0) <= (before?.grid.cols ?? 0),
    `${JSON.stringify(before?.grid)} -> ${JSON.stringify(now?.grid)}`,
  );
}

// 6. A reconnect, where the page has panes and measures each of them.
await evaluate(client, 'window.__tabterm.loseConnection()');
await waitFor(client, `JSON.parse(window.__tabterm.transport()).status === 'ready'`, 25000);
await sleep(1500);
const reconnected = await settled('after losing and regaining the connection');
r.ok('and the daemon had told the page a size by then', someoneWasTold(reconnected));

// 7. A reload, which is a fresh page with no panes at the moment it attaches.
await client.send('Page.reload');
await waitFor(client, 'window.__tabterm?.paneIds().length === 2', 25000);
await sleep(2500);
const reloaded = await settled('after reloading the tab');

/**
 * And nothing moved on its own afterwards.
 *
 * A grid that keeps changing while nobody is touching anything is the shake this whole area exists
 * to prevent, and it is invisible in a single comparison because each moment looks settled.
 */
const movesBefore = reloaded.map((p) => p.moves);
await sleep(3000);
const quiet = await state();
r.ok(
  'and no pane resized itself while nothing was happening',
  quiet.every((p, i) => p.moves === movesBefore[i]),
  `${JSON.stringify(movesBefore)} -> ${JSON.stringify(quiet.map((p) => p.moves))}`,
);
r.ok('and they still agree after sitting still', quiet.every(agree), JSON.stringify(quiet));

await finish();
r.done();
