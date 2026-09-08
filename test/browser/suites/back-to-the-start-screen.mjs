// Going back after opening a session lands on the start screen, not a bare shell.
//
// Reported: "when we're on the homescreen and we press a running now session that's in the
// background, the current tab turns into that session. but when we do go back in chrome, the url
// becomes the same as it was on the homescreen, but it just turns into a regular terminal session
// in ~/ instead of going back to the homescreen."
//
// The cause was a flag in sessionStorage. A tab that had ever left the start screen never went
// back to it, whatever was in it, so Back landed on the start screen's own URL showing an empty
// shell with no way back to the screen it came from.
//
// What makes reconsidering that flag safe is evidence the screen cannot provide, and both halves
// come from the daemon: a pane something was launched into, and a pane somebody typed into
// without ever pressing Enter. The second is the one checked hardest here, because a half-typed
// command sits on the prompt line and leaves the line count at one, which is indistinguishable
// from a prompt nobody has touched.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

// The launcher element stays in the page after it is dismissed. Its input does not, which is
// what tells a start screen that is up from one that has been put away.
const startScreenUp = async () =>
  Number(await evaluate(client, `document.querySelectorAll('.launcher-input').length`)) === 1;

const reason = () => evaluate(client, `JSON.stringify(window.__tabterm.startScreenReason())`);

r.ok('the start screen is up to begin with', await startScreenUp());

// Leave it, the way opening something does. This tab's record now says it has launched.
await evaluate(
  client,
  `[...document.querySelectorAll('.launcher-chip')].find((c) => c.firstChild?.textContent === 'Open')?.click()`,
);
await waitFor(client, `(window.__tabterm.readViewport() ?? '').trim().length > 0`, 20000);
await sleep(800);
r.ok('and it goes away once something is opened', (await startScreenUp()) === false);

/**
 * Back to the URL the start screen had, which is what Chrome's Back button produces: the same
 * tab, no workspace in the URL, and a `sessionStorage` that still remembers launching something.
 */
const base = await evaluate(client, `location.origin + location.pathname`);
const goBackToBase = () => evaluate(client, `location.href = ${JSON.stringify(base)}`);
await goBackToBase();
await sleep(3000);
await waitFor(client, "document.querySelector('.launcher') !== null", 20000);
await sleep(1500);

r.ok(
  'an untouched shell in home comes back to the start screen',
  await startScreenUp(),
  await reason(),
);

/**
 * And the line that must not move: a refresh of a tab that has work in it keeps its terminal.
 *
 * Same URL, workspace and all, which is what a refresh is and what Back is not. The session here
 * has been typed into, so even with nothing on screen but a prompt line it is not an untouched
 * terminal, and no amount of reading that screen could say so.
 */
await evaluate(
  client,
  `[...document.querySelectorAll('.launcher-chip')].find((c) => c.firstChild?.textContent === 'Open')?.click()`,
);
await waitFor(client, `(window.__tabterm.readViewport() ?? '').trim().length > 0`, 20000);
await sleep(800);
await type(client, 'echo never sent', { submit: false });
await sleep(1000);

const withWorkspace = await evaluate(client, `location.href`);
r.ok(
  'opening something puts a workspace in the URL',
  withWorkspace.includes('workspace='),
  withWorkspace,
);

await evaluate(client, `location.reload()`);
await sleep(3000);
await waitFor(client, "document.querySelector('.pane') !== null", 20000);
await sleep(1800);

r.ok(
  'refreshing a tab that has work in it keeps its terminal',
  (await startScreenUp()) === false,
  await reason(),
);

await finish();
r.done();
