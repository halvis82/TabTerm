// Reloading the extension destroys every terminal tab. The terminals themselves carry on in the
// PTY host, so the tabs have to come back on their own: without that the sessions are still
// there and invisible, and reaching them means knowing that the start screen lists them, which
// is not something anybody should have to know after pressing reload.
//
// Written and shipped a while ago and never once demonstrated. This is as close to a
// demonstration as the harness can get, and the part it cannot reach is stated rather than
// glossed over.
import { openTerminal, evaluate, sleep, finish, waitUntil, EXT_ID } from '../helpers.mjs';
import { reporter, listTargets, connect } from '../cdp.mjs';

const r = reporter();

/**
 * TabTerm's service worker, by extension id.
 *
 * A headless Chrome carries several: the built-in ones, plus whatever the profile came with.
 * Taking the first `service_worker` target drove somebody else's extension, which destroyed no
 * tabs and so let the check that mattered pass without proving anything.
 */
const ourWorker = async () =>
  (await listTargets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));

/** Run an expression inside our service worker, which is where all of this lives. */
async function inWorker(expression) {
  const worker = await ourWorker();
  if (!worker) return null;
  const sw = connect(worker.webSocketDebuggerUrl);
  await sw.ready;
  await sw.send('Runtime.enable');
  const value = await evaluate(sw, expression);
  sw.close?.();
  return value;
}

const { client } = await openTerminal();
await sleep(1500);

const workspace = String(
  await evaluate(client, `new URL(location.href).searchParams.get('workspace')`),
);
r.ok('a terminal tab to lose in the first place', workspace !== 'null' && workspace !== '');

/**
 * The service worker writes down which workspaces have tabs.
 *
 * This is the half that has to be right before a reload, because after one there is nothing left
 * to ask. Waited for rather than slept through: it is written on tab events and on an alarm.
 */
const remembered = await waitUntil(async () => {
  const stored = await inWorker(
    `chrome.storage.local.get('tabterm.openWorkspaces').then((s) => JSON.stringify(s['tabterm.openWorkspaces'] ?? []))`,
  );
  return String(stored).includes(workspace);
}, 20000);
r.ok('the service worker writes down which workspaces have tabs', remembered);

/**
 * What a reload does, without the part this harness cannot drive.
 *
 * `chrome.runtime.reload()` was tried first and proves nothing here: the extension is loaded
 * through the debugging protocol, and reloading it that way leaves nothing running at all, so
 * the tabs cannot come back because no code of ours exists to bring them. In the gesture a
 * person actually makes, reloading from `chrome://extensions`, Chrome fires `onInstalled` and
 * starts the worker itself.
 *
 * So the two halves are separated. Chrome destroying the tabs is Chrome's part and is not worth
 * asserting. Putting them back is ours, and that is what runs here.
 */
const originalId = (await listTargets()).find((t) => t.url.includes(`workspace=${workspace}`))?.id;
await client.send('Page.close').catch(() => {});
await sleep(800);
r.ok(
  'the tab is gone, as a reload would leave it',
  !(await listTargets()).some((t) => t.id === originalId),
  String(originalId),
);

/**
 * The record put back the way a reload leaves it.
 *
 * Closing the tab here fired `onRemoved`, which correctly rewrote the record without it: a tab
 * somebody closes must never be resurrected. A reload fires nothing, because the listener goes
 * with everything else, so the record still names the tab. That difference is the feature, and
 * restoring the record is how this reaches the state a reload actually leaves.
 */
await inWorker(
  `chrome.storage.local.set({ 'tabterm.openWorkspaces': [${JSON.stringify(workspace)}] })`,
);
await inWorker(`chrome.storage.session.remove('tabterm.workerAwake')`);

/**
 * Stop the worker, then let it start again, which is what runs the extension's own startup.
 *
 * The reopen lives at the top of the service worker, so the way to exercise it is to make the
 * worker start. Stopping it through the debugging protocol is the honest version of that: the
 * real code runs, in the real place, with the state a reload leaves behind.
 */
const workerTarget = await ourWorker();
const version = await (
  await fetch(`http://127.0.0.1:${process.env.TT_CDP_PORT ?? '9223'}/json/version`)
).json();
const browser = connect(version.webSocketDebuggerUrl);
await browser.ready;
if (workerTarget) {
  await browser.send('Target.closeTarget', { targetId: workerTarget.id }).catch(() => {});
}
await sleep(600);
r.ok('the worker can be stopped, so its startup can be watched', (await ourWorker()) === undefined);

// Anything at all wakes it. A tab event is the cheapest, and it is also what a person browsing
// would produce within seconds anyway.
const nudge = await fetch(
  `http://127.0.0.1:${process.env.TT_CDP_PORT ?? '9223'}/json/new?about:blank`,
  { method: 'PUT' },
).catch(() => null);
void nudge;

/**
 * Did the worker start again at all?
 *
 * Asserted separately from the reopen, because the two failures look identical from outside and
 * mean completely different things. A worker that never started says nothing about whether the
 * reopen works; a worker that started and reopened nothing is a defect.
 */
const workerRestarted = await waitUntil(async () => (await ourWorker()) !== undefined, 20000);
r.ok('the service worker starts again once something wakes it', workerRestarted);

const reopened = await waitUntil(async () => {
  const now = await listTargets();
  return now.some(
    (t) => t.id !== originalId && t.url.includes('terminal.html') && t.url.includes(workspace),
  );
}, 20000);
r.ok('a tab for the remembered workspace comes back', reopened, `was ${String(originalId)}`);

/**
 * Exactly one of it, however many things asked for the reopen.
 *
 * Three separate events can mean "the extension has just started" and Chrome fires whichever it
 * likes. Two of them arriving put back two of every tab: each read the same empty list of open
 * tabs and each created one. A person came back to a session showing in a pair of tabs, which is
 * the one thing this product promises never to do.
 *
 * Asked for twice on purpose here, at once, which is the shape of that failure.
 */
const tabsFor = async () =>
  (await listTargets()).filter((t) => t.url.includes(`workspace=${workspace}`)).length;

// The tab that came back is closed first, so this is the same starting point the reload leaves:
// a remembered workspace with no tab showing it.
const back = (await listTargets()).find((t) => t.url.includes(`workspace=${workspace}`));
if (back) {
  await fetch(`http://127.0.0.1:${process.env.TT_CDP_PORT ?? '9223'}/json/close/${back.id}`).catch(
    () => null,
  );
}
await sleep(700);
await inWorker(
  `chrome.storage.local.set({ 'tabterm.openWorkspaces': [${JSON.stringify(workspace)}] })`,
);
/**
 * Two start events at once, in both the shapes that actually happen.
 *
 * A fresh call beside an ordinary one is two triggers where the second joins the first: the
 * shared promise is what makes that one tab. Two fresh calls are two independent runs, which is
 * what happened on the machine: each read the same empty list of tabs and each created one. The
 * look-again immediately before each create is what makes that one tab.
 */
await inWorker(
  `Promise.all([globalThis.__tabtermReopen(true), globalThis.__tabtermReopen()]).then(() => 'done')`,
);
await sleep(2000);
r.ok(
  'a second trigger joins the first rather than reopening everything again',
  (await tabsFor()) === 1,
  `${String(await tabsFor())} tabs showing that workspace`,
);

await inWorker(
  `Promise.all([globalThis.__tabtermReopen(true), globalThis.__tabtermReopen(true)]).then(() => 'done')`,
);
await sleep(2000);
r.ok(
  'and two independent reopens still leave exactly one tab',
  (await tabsFor()) === 1,
  `${String(await tabsFor())} tabs showing that workspace`,
);

/**
 * And it is attached to the same terminal, which is the entire point.
 *
 * A tab that came back showing a fresh shell would be worse than no tab at all: it would look
 * like the work had survived when it had not.
 */
const backTab = (await listTargets()).find(
  (t) => t.id !== originalId && t.url.includes(`workspace=${workspace}`),
);
if (backTab) {
  const back = connect(backTab.webSocketDebuggerUrl);
  await back.ready;
  await back.send('Runtime.enable');
  /**
   * Looked at, because a reopened tab is deliberately not.
   *
   * Several coming back at once must not fight over which is in front, and a reload is not a
   * request to be taken anywhere, so they open in the background and suspend: "Suspended.
   * Activate this tab to reconnect." Reconnecting on being looked at is the behavior, and
   * asserting against a tab nobody has looked at was asserting the wrong thing.
   */
  await back.send('Page.bringToFront').catch(() => {});
  const attached = await waitUntil(async () => {
    const screen = await evaluate(back, `window.__tabterm?.readScreen() ?? ''`).catch(() => '');
    return String(screen).trim() !== '';
  }, 20000);
  const body = String(
    await evaluate(back, `document.body.innerText.slice(0, 120)`).catch(() => ''),
  );
  r.ok('and it is showing a terminal, not an expiry notice', attached, body.replace(/\n+/g, ' | '));
  back.close?.();
} else {
  r.ok('and it is showing a terminal, not an expiry notice', false, 'no tab came back');
}

await finish();
r.done();
