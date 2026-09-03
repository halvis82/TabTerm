// Landmarks in the scrollback, and the rail that finds them again.
//
// A landmark is printed into the session's output, never sent to the shell, so it behaves like
// the rest of the scrollback: it scrolls with the work it marks and survives a reload.
import {
  openTerminal,
  evaluate,
  readScreen,
  sleep,
  type,
  finish,
  realClick,
  openPaneMenu,
  waitFor,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo before-the-landmark\r');
await sleep(1200);

await openPaneMenu(client, 60, 60);
await sleep(250);
r.ok(
  'the pane menu offers a marker',
  await evaluate(
    client,
    "[...document.querySelectorAll('.term-menu-item')].some((b) => b.textContent === 'Add a marker here')",
  ),
);
// A real press and release, since that is what a hand does and what the menu used to ignore.
await realClick(client, '.term-menu-item', 'Add a marker here');
await sleep(500);
await evaluate(client, "document.querySelector('.pane-label-input').value = 'before the deploy'");
await realClick(client, '.pane-label-color:nth-of-type(3)');
await realClick(client, '.pane-label-form .term-menu-item', 'Save');
await sleep(2000);

const screen = await readScreen(client);
r.ok('the landmark is printed into the output', screen.includes('before the deploy'));
r.ok(
  'and the shell never ran it',
  !screen.includes('echo before the deploy'),
  'output, not input: it must not reach whatever program is in the foreground',
);

// Push it well up into the scrollback.
await type(client, 'seq 1 300\r');
await sleep(3500);

const markers = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.markers())'));
r.ok(
  'one landmark is found, not one per line of it',
  markers.length === 1,
  JSON.stringify(markers),
);
r.ok(
  'a pip appears beside the scrollbar',
  Number(await evaluate(client, "document.querySelectorAll('.marker-pip').length")) === 1,
);

const before = Number(await evaluate(client, 'window.__tabterm.viewportY()'));
const pip = JSON.parse(
  await evaluate(
    client,
    "(() => { const b = document.querySelector('.marker-pip').getBoundingClientRect(); return JSON.stringify({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }); })()",
  ),
);
await client.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: Math.round(pip.x),
  y: Math.round(pip.y),
  button: 'left',
  clickCount: 1,
});
await sleep(900);
const after = Number(await evaluate(client, 'window.__tabterm.viewportY()'));
r.ok(
  'clicking it scrolls back to the landmark',
  after < before,
  `${String(before)} -> ${String(after)}`,
);

/**
 * The bar spans the pane it was printed into.
 *
 * A landmark is found by looking like a solid full-width bar, so one printed narrower than the
 * pane is both ugly and, at the far columns, not a landmark at all. The width used to come from
 * the daemon's idea of the terminal size, which is 80 columns for a session adopted after a
 * daemon restart until a tab reattaches and resizes it. The pane sends its own width now.
 */
const spans = JSON.parse(
  await evaluate(
    client,
    `(() => {
       const cols = window.__tabterm.geometry()?.cols ?? 0;
       // The bar is painted with an explicit background on every cell, so its width is the run
       // of colored cells on its line. Two columns of slack: the block is deliberately one
       // short of the terminal, because a line written to the last column wraps on its own.
       for (let y = 0; y < 60; y++) {
         const runs = window.__tabterm.lineColors(y);
         if (runs.length === 1 && runs[0].text.trim() === '' && runs[0].text.length > 20) {
           return JSON.stringify({ cols, width: runs[0].text.length });
         }
       }
       return JSON.stringify({ cols, width: 0 });
     })()`,
  ),
);
r.ok(
  'the bar spans the pane it was printed into',
  spans.width > 0 && spans.cols - spans.width <= 2,
  JSON.stringify(spans),
);

await finish();
r.done();
