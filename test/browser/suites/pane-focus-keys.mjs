// Moving between panes with the keyboard, which had no key at all until now.
//
// Asked for as cycling with Option and Tab. That one is not available: this terminal sends Option
// as Meta on purpose, because it is what terminal users expect, and a shell binds Meta and Tab to
// completing a word. Measured rather than assumed: with `ech` at the prompt, pressing it produced
// `echo`. Control and Command with an arrow was measured the same way and the shell does nothing
// with it, so that is the default, and like every other shortcut here it can be changed.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo FOCUS-KEYS\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('FOCUS-KEYS')`, 20000);

await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, 'window.__tabterm.paneIds().length === 2', 20000);
await evaluate(client, "window.__tabterm.split('vertical')");
await waitFor(client, 'window.__tabterm.paneIds().length === 3', 20000);
await sleep(1500);

const panes = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
);
r.ok('three panes to move between', panes.length === 3, String(panes.length));

const focused = async () => String(await evaluate(client, `window.__tabterm.focusedPane()`));

/** A real press, with both halves, because a shortcut is a press and a release. */
const press = async (key, code, nativeCode) => {
  for (const kind of ['rawKeyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type: kind,
      modifiers: 2 | 4, // Control and Command
      key,
      code,
      windowsVirtualKeyCode: key === 'ArrowRight' ? 39 : 37,
      nativeVirtualKeyCode: nativeCode,
    });
  }
  await sleep(400);
};

await evaluate(client, `window.__tabterm.focus(${JSON.stringify(panes[0])})`);
await sleep(400);
r.ok('starting on the first pane', (await focused()) === panes[0], await focused());

await press('ArrowRight', 'ArrowRight', 124);
r.ok('moves to the next pane', (await focused()) === panes[1], await focused());

await press('ArrowRight', 'ArrowRight', 124);
r.ok('and on to the one after that', (await focused()) === panes[2], await focused());

/*
 * And round, because a tab of panes is a ring in use: getting back to the first should not mean
 * reaching for the mouse.
 */
await press('ArrowRight', 'ArrowRight', 124);
r.ok('and wraps round to the first', (await focused()) === panes[0], await focused());

await press('ArrowLeft', 'ArrowLeft', 123);
r.ok(
  'and the other arrow goes back the other way',
  (await focused()) === panes[2],
  await focused(),
);

/*
 * And it is not stealing anything from the shell, which is the reason Option and Tab was refused.
 * The prompt is left exactly as it was.
 */
await evaluate(client, `window.__tabterm.focus(${JSON.stringify(panes[0])})`);
await sleep(300);
await type(client, 'ech', { submit: false });
await sleep(500);
const before = String(
  await evaluate(client, `window.__tabterm.readScreen(${JSON.stringify(panes[0])}) ?? ''`),
);
await press('ArrowRight', 'ArrowRight', 124);
await evaluate(client, `window.__tabterm.focus(${JSON.stringify(panes[0])})`);
await sleep(400);
const after = String(
  await evaluate(client, `window.__tabterm.readScreen(${JSON.stringify(panes[0])}) ?? ''`),
);
r.ok(
  'and the shell never saw it, so nothing was completed or typed',
  before.trim() === after.trim(),
  `${before.trim().slice(-30)} | ${after.trim().slice(-30)}`,
);

await finish();
r.done();
