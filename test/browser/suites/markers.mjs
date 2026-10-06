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

/** Where the pip for a landmark is drawn, as a point to ask the page about. */
const pipAt = async (which) =>
  JSON.parse(
    await evaluate(
      client,
      `(() => { const pips = [...document.querySelectorAll('.marker-pip')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
         const b = pips[${String(which)}].getBoundingClientRect();
         return JSON.stringify({ x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) }); })()`,
    ),
  );
/** What is actually on top at a point, which is what a click there would land on. */
const onTopAt = ({ x, y }) =>
  evaluate(
    client,
    `(() => { const el = document.elementFromPoint(${String(x)}, ${String(y)});
       if (!el) return 'nothing';
       if (el.closest('.cmd-panel')) return 'panel';
       if (el.closest('#cmd-button')) return 'button';
       if (el.classList.contains('marker-pip')) return 'pip';
       return el.className || el.tagName; })()`,
  );

/**
 * A pip in the corner stays under the command button, and every pip stays under the open menu.
 *
 * The rail was drawn above both for a while, so that a landmark in the first thirty pixels of the
 * scrollback could be pressed through the button. What that looked like was pips drawn crisp over
 * the button and straight through the menu, reported as a bug from a screenshot of exactly that.
 * This landmark is near the top of the buffer, so its pip is the one the button covers.
 */
r.ok(
  'a pip in the corner is under the command button rather than drawn over it',
  (await onTopAt(await pipAt(0))) === 'button',
  await onTopAt(await pipAt(0)),
);

/** A second landmark, far enough down the buffer that nothing in the corner covers its pip. */
const addMarker = async (label, color) => {
  await openPaneMenu(client, 60, 60);
  await sleep(250);
  await realClick(client, '.term-menu-item', 'Add a marker here');
  await sleep(500);
  await evaluate(
    client,
    `document.querySelector('.pane-label-input').value = ${JSON.stringify(label)}`,
  );
  await realClick(client, `.pane-label-color:nth-of-type(${String(color)})`);
  await realClick(client, '.pane-label-form .term-menu-item', 'Save');
  await sleep(2000);
};
await addMarker('halfway down', 3);
await type(client, 'seq 1 300\r');
await sleep(3500);
await waitFor(client, "document.querySelectorAll('.marker-pip').length === 2", 8000);

{
  const lower = await pipAt(1);
  /**
   * Away from the corner, the pip itself is on top.
   *
   * The emulator draws its own scrollbar over the same strip, at a z-index of its own, and a
   * pip under that could be seen and never pressed: a click there scrolled a page, which looks
   * like a jump to anyone not checking where it landed.
   */
  r.ok(
    'a pip away from the corner is on top, so a press reaches it',
    (await onTopAt(lower)) === 'pip',
    await onTopAt(lower),
  );
  await evaluate(client, "document.querySelector('#cmd-button')?.click()");
  await waitFor(client, "document.querySelector('.cmd-panel')?.hidden === false");
  // Let the panel take its size and settle where it remembers being, then put it over the pip,
  // the way the screenshot had it. Moving it earlier is undone by its own placement.
  await sleep(700);
  const box = JSON.parse(
    await evaluate(
      client,
      `(() => { const p = document.querySelector('.cmd-panel');
         const b = p.getBoundingClientRect();
         p.style.left = '${String(Math.max(0, lower.x - 230))}px';
         p.style.top = String(Math.max(0, ${String(lower.y)} - Math.round(b.height / 2))) + 'px';
         const after = p.getBoundingClientRect();
         return JSON.stringify({ left: after.left, top: after.top, width: after.width, height: after.height }); })()`,
    ),
  );
  await sleep(300);
  const covered =
    lower.x >= box.left &&
    lower.x <= box.left + box.width &&
    lower.y >= box.top &&
    lower.y <= box.top + box.height;
  r.ok(
    'and the open menu covers a pip rather than letting it show through',
    covered && (await onTopAt(lower)) === 'panel',
    `${await onTopAt(lower)} at ${JSON.stringify(lower)} with the panel at ${JSON.stringify(box)}`,
  );
  await evaluate(client, "document.querySelector('#cmd-button')?.click()");
  await waitFor(client, "document.querySelector('.cmd-panel')?.hidden === true");
  await sleep(300);
}

const before = Number(await evaluate(client, 'window.__tabterm.viewportY()'));
const pip = await pipAt(1);
await client.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: pip.x,
  y: pip.y,
  button: 'left',
  clickCount: 1,
});
await sleep(900);
const after = Number(await evaluate(client, 'window.__tabterm.viewportY()'));
r.ok(
  'clicking a pip scrolls back to its landmark',
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

/**
 * And the keyboard goes back to the terminal.
 *
 * The form took it to be typed into, and removing the form left it nowhere: whoever marked a
 * place and carried on typing lost the first characters of whatever came next.
 */
{
  await sleep(300);
  const state = JSON.parse(
    await evaluate(
      client,
      `(() => { const a = document.activeElement;
         return JSON.stringify({
           active: a ? (a.className || a.tagName) : 'none',
           // xterm marks the terminal focused, which is what draws a solid cursor rather than
           // a hollow one. Being able to type into something that does not look like it is
           // taking typing is its own kind of broken.
           looksFocused: !!document.querySelector('.xterm.focus, .terminal.focus'),
         }); })()`,
    ),
  );
  r.ok(
    'after saving a marker the terminal has the keyboard again',
    String(state.active).includes('xterm-helper-textarea'),
    JSON.stringify(state),
  );
  r.ok('and looks like it', state.looksFocused === true, JSON.stringify(state));
  const MARK = `AFTER-MARKER-${String(Date.now()).slice(-5)}`;
  await type(client, `echo ${MARK}`);
  const landed = await waitFor(
    client,
    `(window.__tabterm.readScreen() ?? '').includes(${JSON.stringify(MARK)})`,
    12000,
  );
  r.ok('and what is typed next reaches the shell', landed);
}

await finish();
r.done();
