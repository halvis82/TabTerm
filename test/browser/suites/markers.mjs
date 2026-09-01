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
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await sleep(4500);
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

await finish();
r.done();
