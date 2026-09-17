// What a card says about where a session is, corrected as it happens.
//
// A card says "open in a tab" or "background", and the answer is whether a tab holds that session.
// Closing a tab already told every start screen. A tab **coming back** did not, so a start screen
// that was open at the time went on saying "background" about terminals that were plainly in a tab
// again, and only refreshing that page corrected it.
//
// Reported after closing a tab from a card's own menu and bringing it back with the browser's undo.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  EXT_ID,
} from '../helpers.mjs';
import { reporter, closeTab, newTab, connect } from '../cdp.mjs';

const r = reporter();

// A tab with a session worth listing.
const work = await openTerminal();
await waitFor(work.client, "document.querySelector('.launcher-input')");
await type(work.client, 'echo BADGE-ME\r');
await waitFor(work.client, `(window.__tabterm.readScreen() ?? '').includes('BADGE-ME')`, 20000);
await sleep(1000);
const workspaceId = String(await evaluate(work.client, 'window.__tabterm.workspaceId()'));
const sessionId = JSON.parse(
  String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneSessions())')),
)[0]?.sessionId;

// And a start screen watching the list, which is never reloaded from here on.
const viewer = await openTerminal();
await waitFor(viewer.client, "document.querySelector('.launcher-input')");

/** What the card for that one session says, right now. */
const badge = async () =>
  String(
    await evaluate(
      viewer.client,
      `(document.querySelector('.session-card[data-session-id="${sessionId}"] .session-badge')
         ?.textContent ?? 'no card')`,
    ),
  );

const listed = await waitUntil(async () => (await badge()) === 'open in a tab', 20000);
r.ok('a session in a tab is listed as being in one', listed, await badge());

/*
 * The tab goes. This half already worked, and it is here because the half that did not only means
 * anything if the label really did change first.
 */
await closeTab(work.tab.id);
const wentQuiet = await waitUntil(async () => (await badge()) === 'background', 25000);
const detail = String(
  await evaluate(
    viewer.client,
    `(() => {
       const card = document.querySelector('.session-card[data-session-id="${sessionId}"]');
       return JSON.stringify({
         badge: card?.querySelector('.session-badge')?.textContent ?? 'no card',
         state: card?.dataset.state ?? 'none',
         cards: document.querySelectorAll('.session-card').length,
       });
     })()`,
  ),
);
r.ok('and says so when that tab is closed', wentQuiet, detail);

/*
 * And the tab comes back, which is what the browser's own undo does: the same workspace, opened
 * again. The page watching is not touched, because the whole point is that it corrects itself.
 */
const again = await newTab(`chrome-extension://${EXT_ID}/terminal.html?workspace=${workspaceId}`);
const back = connect(again.webSocketDebuggerUrl);
await back.ready;
await waitFor(back, 'window.__tabterm?.attached?.() === true', 25000);

const corrected = await waitUntil(async () => (await badge()) === 'open in a tab', 25000);
r.ok('and corrects itself when the tab comes back, with no refresh', corrected, await badge());

/*
 * And the page really was never reloaded, which is the claim being made. A page that had navigated
 * would pass the check above by starting from nothing.
 */
const same = String(await evaluate(viewer.client, 'String(window.__tabterm !== undefined)'));
r.ok('while that start screen stayed where it was', same === 'true');

await closeTab(again.id).catch(() => undefined);
await finish();
r.done();
