// His sequence exactly: at the start screen, open a background session from Running Now, go Back.
//
// Reported twice. The first fix covered a case that was not his: it navigated to the bare URL,
// which is what Back produces only for a tab that never created a session of its own. A start
// screen creates a shell the moment it opens and is given a workspace for it, so the URL it has
// by the time anything is clicked already names one, and Back returns to **that**, not to a bare
// address. The tab then reattached to its own untouched shell and showed a terminal.
//
// So this drives the real thing: a real Running Now card, a real click, and Chrome's own history.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter, closeTab } from '../cdp.mjs';

const r = reporter();

// A session for Running Now to list, in a tab that then goes away so it is in the background.
const donor = await openTerminal();
await waitFor(donor.client, "document.querySelector('.launcher-input')");
await type(donor.client, 'echo BACKGROUND-DONOR');
await sleep(2500);
const donorWorkspace = String(
  await evaluate(donor.client, `new URL(location.href).searchParams.get('workspace') ?? ''`),
);
r.ok('a session exists to be listed', donorWorkspace !== '', donorWorkspace);
await closeTab(donor.tab.id);
await sleep(1500);

// The tab he is actually looking at: a start screen, which makes a shell and a workspace of its
// own, which is the whole reason Back does not reach a bare URL.
const here = await openTerminal();
await waitFor(here.client, "document.querySelector('.launcher-input')");
await sleep(2500);

const startScreenUp = async () =>
  Number(await evaluate(here.client, `document.querySelectorAll('.launcher-input').length`)) === 1;
const url = () => evaluate(here.client, `location.href`);
const reason = () => evaluate(here.client, `JSON.stringify(window.__tabterm.startScreenReason())`);

r.ok('the start screen is up', await startScreenUp());
const before = await url();
r.ok('and it already has a workspace of its own in the URL', before.includes('workspace='), before);

// The card for the background session, clicked the way a person clicks it.
const clicked = await evaluate(
  here.client,
  `(() => {
     const card = [...document.querySelectorAll('.session-card')]
       .find((c) => c.dataset.state === 'detached');
     if (!card) return 'no detached card';
     card.click();
     return 'clicked';
   })()`,
);
r.ok('a background session is listed and clickable', clicked === 'clicked', clicked);

await sleep(3000);
const after = await url();
r.ok('the tab became that session', after !== before && after.includes(donorWorkspace), after);

// Chrome's Back, not a synthetic navigation to a URL of our choosing.
await evaluate(here.client, `history.back()`);
await sleep(3500);
await waitFor(here.client, "document.querySelector('.launcher') !== null", 20000);
await sleep(1800);

r.ok(
  'Back returns to the same URL it left',
  (await url()) === before,
  `${await url()} vs ${before}`,
);
r.ok('and shows the start screen, not a bare shell', await startScreenUp(), await reason());

await finish();
r.done();
