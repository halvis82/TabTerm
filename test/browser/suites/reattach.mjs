// Reloading a session is not starting one.
//
// The start panel belongs to a new tab: it is drawn over an empty terminal because there is no
// output yet. After a reload the session already exists and may have a screenful of output, and
// that output used to end up crammed into the small strip the panel leaves behind, which is
// what a reload looked like from the outside: the menu comes back and everything is squashed.
import { openTerminal, evaluate, readScreen, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

const view = () =>
  evaluate(
    client,
    `(() => {
      const pane = document.querySelector('.pane');
      const rect = pane?.getBoundingClientRect();
      return JSON.stringify({
        hasWorkspaceParam: new URLSearchParams(location.search).has('workspace'),
        panelVisible: !document.querySelector('.launcher')?.hidden,
        paneHeight: rect ? Math.round(rect.height) : 0,
        viewport: window.innerHeight,
      });
    })()`,
  ).then((s) => JSON.parse(s));

const fresh = await view();
r.ok('a new tab shows the panel', fresh.panelVisible === true);

await evaluate(client, `document.querySelector('.pane.focused .xterm-helper-textarea')?.focus()`);
for (const ch of 'echo RELOAD-MARKER') {
  await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
  await sleep(4);
}
await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r' });
await sleep(1500);

const ran = await view();
r.ok('running a command dismisses it and gives back the window', ran.panelVisible === false);
r.ok('the URL now names the workspace', ran.hasWorkspaceParam === true);

await client.send('Page.reload', {});
await sleep(5500);

const reloaded = await view();
r.ok('the panel does not come back on reload', reloaded.panelVisible === false);
r.ok(
  'and the terminal keeps the whole window',
  reloaded.paneHeight / reloaded.viewport > 0.8,
  `${String(reloaded.paneHeight)}px of ${String(reloaded.viewport)}px`,
);
r.ok(
  'the output from before the reload is still there',
  (await readScreen(client)).includes('RELOAD-MARKER'),
);

/**
 * And a refresh from the start screen keeps the prompt in the strip.
 *
 * Reported three times as "the prompt is gone from the box at the bottom". It was never gone: a
 * restored screen is the session's whole twenty-four row screen, with the prompt on the first
 * line and blanks under it, and the strip scrolled to the bottom of that. Two blank rows look
 * exactly like a broken terminal, and typing into it works while showing nothing.
 *
 * Read from the viewport rather than the buffer, because the buffer cannot tell "there" from
 * "on screen", which is the whole distinction this is about.
 */
const second = await openTerminal();
await waitFor(second.client, "document.querySelector('.launcher-input')");
await waitFor(second.client, `(window.__tabterm.readViewport() ?? '').trim().length > 0`, 20000);
await evaluate(second.client, 'location.reload()');
await sleep(5000);
await waitFor(second.client, "document.querySelector('.launcher-input')");
const promptBack = await waitFor(
  second.client,
  `(window.__tabterm?.readViewport() ?? '').trim().length > 0`,
  20000,
);
r.ok(
  'refreshing the start screen leaves the prompt visible in the strip',
  promptBack,
  JSON.stringify(String(await evaluate(second.client, `window.__tabterm.readViewport()`))),
);
r.ok(
  'and the start screen is still up, since nothing has been started here',
  Number(await evaluate(second.client, `document.querySelectorAll('.launcher-input').length`)) ===
    1,
);

await finish();
r.done();
