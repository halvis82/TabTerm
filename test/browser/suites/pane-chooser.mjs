// An empty pane offers somewhere to go, rather than a bare prompt.
//
// Splitting used to produce two empty shells in the home directory, and the first thing anybody
// does with one is go somewhere. So a pane with nothing in it offers the two things worth doing:
// pick a folder, or bring a session that already exists here.
import { openTerminal, evaluate, sleep, type, finish, realClick, waitFor } from '../helpers.mjs';
import { listTargets, reporter } from '../cdp.mjs';

const r = reporter();

// One tab holding a session that has actually been used, left open.
const a = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(a.client, "document.querySelector('.launcher-input')");
await type(a.client, 'echo TAKEN-OVER-MARKER\r');
await sleep(1600);
r.ok(
  "both tabs talk to this run's own daemon, not the one somebody is working in",
  String(await evaluate(a.client, 'JSON.parse(window.__tabterm.transport()).port')) ===
    String(process.env.TT_DAEMON_PORT),
  `tab on ${String(await evaluate(a.client, 'JSON.parse(window.__tabterm.transport()).port'))}, run on ${String(process.env.TT_DAEMON_PORT)}`,
);
r.ok(
  'the marker was typed into the terminal, not into the path box',
  String(await evaluate(a.client, 'window.__tabterm.readScreen() ?? ""')).includes(
    'TAKEN-OVER-MARKER',
  ),
  String(await evaluate(a.client, 'document.activeElement?.className ?? ""')),
);
const sourceWorkspace = String(await evaluate(a.client, 'window.__tabterm.workspaceId()'));
const sourceSession = String(
  /**
   * Waited for, and read without assuming.
   *
   * A tab that has not finished attaching has no panes. Reading one then throws and takes the
   * whole suite with it, which under load is a failure that names nothing about what went wrong.
   */
  await waitFor(a.client, 'JSON.parse(window.__tabterm.transport()).panes.length > 0', 20000).then(
    () => evaluate(a.client, `JSON.parse(window.__tabterm.transport()).panes[0]?.sessionId ?? ''`),
  ),
);

const b = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(b.client, "document.querySelector('.launcher-input')");
// Use the tab first, the way a person does. Splitting with the start screen still up leaves the
// panes in the thin strip it leaves for the terminal, which is not a state anybody reaches.
await type(b.client, 'echo second-tab\r');
await sleep(1500);
await evaluate(b.client, "window.__tabterm.split('horizontal')");
await sleep(3500);

r.ok(
  'the new empty pane offers a chooser',
  Number(await evaluate(b.client, "document.querySelectorAll('.pane-chooser-box').length")) === 1,
  'and the pane already in use does not, since covering output would offer to replace it',
);

/*
 * Open a folder: the start screen's own picker, starting in this pane's folder.
 *
 * A path box that Tab completes, and the folders inside wherever it points as chips under it.
 */
const pickerStart = String(
  await evaluate(b.client, "document.querySelector('.pane-chooser .launcher-input')?.value ?? ''"),
);
r.ok('the folder box starts in a folder, not empty', pickerStart.endsWith('/'), pickerStart);
const arrived = await waitFor(
  b.client,
  "document.querySelectorAll('.pane-chooser .launcher-completion').length > 1",
  15000,
);
r.ok(
  'and the folders inside it are listed under it',
  arrived,
  String(
    await evaluate(
      b.client,
      "document.querySelectorAll('.pane-chooser .launcher-completion').length",
    ),
  ),
);
// Clicking a folder goes into it, the way the start screen does.
const first = String(
  await evaluate(
    b.client,
    `(() => { const c = [...document.querySelectorAll('.pane-chooser .launcher-completion')].find((x) => !x.classList.contains('is-up') && !x.classList.contains('is-more'));
       if (!c) return ''; c.click(); return c.textContent; })()`,
  ),
);
await sleep(300);
const intoIt = String(
  await evaluate(b.client, "document.querySelector('.pane-chooser .launcher-input')?.value ?? ''"),
);
r.ok(
  'clicking a folder goes into it',
  first !== '' && intoIt.endsWith(`${first}/`),
  `${first} -> ${intoIt}`,
);
// And Tab completes in the box, without the key reaching the shell.
await evaluate(
  b.client,
  `(() => { const i = document.querySelector('.pane-chooser .launcher-input'); i.value = ${JSON.stringify(pickerStart)} + ${JSON.stringify(first.slice(0, -1))}; i.focus(); i.dispatchEvent(new Event('input')); })()`,
);
await b.client.send('Input.dispatchKeyEvent', {
  type: 'rawKeyDown',
  key: 'Tab',
  code: 'Tab',
  windowsVirtualKeyCode: 9,
});
await b.client.send('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'Tab',
  code: 'Tab',
  windowsVirtualKeyCode: 9,
});
const completed = await waitFor(
  b.client,
  `(document.querySelector('.pane-chooser .launcher-input')?.value ?? '').length > ${String(pickerStart.length + first.length - 1)}`,
  8000,
);
r.ok(
  'Tab completes the folder name',
  completed,
  String(
    await evaluate(b.client, "document.querySelector('.pane-chooser .launcher-input')?.value"),
  ),
);
// Anchored to the bottom of the pane, not merely low in it: a terminal fills from the top, so
// what matters is that the panel never reaches the line being typed.
const anchored = JSON.parse(
  await evaluate(
    b.client,
    `(() => { const box = document.querySelector('.pane-chooser-box').getBoundingClientRect();
       const pane = document.querySelector('.pane-chooser').closest('.pane').getBoundingClientRect();
       return JSON.stringify({ gap: Math.round(pane.bottom - box.bottom), clearOfTop: Math.round(box.top - pane.top) }); })()`,
  ),
);
r.ok(
  'the panel is anchored to the bottom of the pane',
  anchored.gap >= 0 && anchored.gap <= 20,
  JSON.stringify(anchored),
);
r.ok(
  'and leaves the first line free to type on',
  anchored.clearOfTop > 20,
  JSON.stringify(anchored),
);

/*
 * Bring a session here: one big button, and the list floats out of it over most of the tab.
 */
const takeButton = String(
  await evaluate(b.client, "document.querySelector('.pane-chooser-take')?.textContent ?? ''"),
);
r.ok(
  'there is a button to bring a session here',
  takeButton.includes('Bring a session here'),
  takeButton,
);
await realClick(b.client, '.pane-chooser-take');
await waitFor(
  b.client,
  "document.querySelectorAll('.take-bubble .pane-chooser-session').length > 0",
  15000,
);
const bubble = JSON.parse(
  await evaluate(
    b.client,
    `(() => { const r = document.querySelector('.take-bubble').getBoundingClientRect();
       const listed = [...document.querySelectorAll('.take-bubble .pane-chooser-session')].map((c) => c.dataset.session);
       const mine = window.__tabterm.paneSessions().map((p) => p.sessionId);
       return JSON.stringify({ share: (r.width * r.height) / (innerWidth * innerHeight), listed, mine,
         kill: document.querySelectorAll('.take-bubble .session-close, .take-bubble [title*="End"]').length }); })()`,
  ),
);
r.ok('the list takes up most of the tab', bubble.share > 0.4, JSON.stringify(bubble.share));
r.ok(
  'it lists the session in the other tab',
  bubble.listed.some((id) => id.startsWith(sourceSession.slice(0, 8))),
  JSON.stringify(bubble.listed),
);
r.ok(
  'and none of the sessions already in this tab',
  !bubble.listed.some((id) => bubble.mine.includes(id)),
  JSON.stringify(bubble),
);
r.ok('and offers no way to end one', bubble.kill === 0, String(bubble.kill));
// A press outside it puts it away.
await b.client.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: 6,
  y: 6,
  button: 'left',
  clickCount: 1,
});
await b.client.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: 6,
  y: 6,
  button: 'left',
  clickCount: 1,
});
const gone = await waitFor(b.client, "!document.querySelector('.take-scrim')", 3000);
r.ok('a press outside the bubble puts it away', gone);
await realClick(b.client, '.pane-chooser-take');
await waitFor(
  b.client,
  "document.querySelectorAll('.take-bubble .pane-chooser-session').length > 0",
  15000,
);

// A session already open in a tab says so before it is moved.
// Exactly the session this suite opened, not whichever attached row happens to be first: a
// machine mid-session has others, and taking one of those proves nothing about this behavior.
// Matched on the prefix, because the test hook reports ids shortened for readability.
const clickAttached = `(() => {
  const row = document.querySelector('.pane-chooser-session[data-session^="${sourceSession}"]');
  if (!row) return '';
  row.click();
  return row.textContent;
})()`;
const clicked = String(await evaluate(b.client, clickAttached));
const offered = String(
  await evaluate(
    b.client,
    `JSON.stringify([...document.querySelectorAll('.pane-chooser-session')].map((r) => (r.dataset.session ?? '').slice(0, 8) + ':' + r.textContent.slice(0, 26)))`,
  ),
);
const tabs = (await listTargets()).filter((t) => t.url.includes('terminal.html'));
r.ok(
  'only the tabs this suite opened exist',
  tabs.length === 2,
  `${String(tabs.length)} terminal tabs`,
);
r.ok(
  'a session open in a tab is marked as such',
  clicked.includes('open in a tab'),
  `clicked=${clicked.slice(0, 30)} want=${sourceSession.slice(0, 12)} offered=${offered}`,
);

await sleep(700);
const warned = String(
  await evaluate(b.client, "document.querySelector('.pane-chooser-warn')?.textContent ?? ''"),
);
r.ok('and asks before taking it', warned.includes('Click again to move it here'), warned);

const before = (await listTargets()).filter((t) => t.url.includes('terminal.html')).length;
// Pressed and released, not `.click()`, since that is what a hand does.
await realClick(b.client, '.pane-chooser-session.is-confirming');
await sleep(4000);

const after = (await listTargets()).filter((t) => t.url.includes('terminal.html'));
r.ok(
  'the tab it came from closes, so it is never open twice',
  !after.some((t) => t.url.includes(sourceWorkspace)) && after.length < before,
  `${String(before)} -> ${String(after.length)}`,
);

const screens = JSON.parse(
  await evaluate(
    b.client,
    'JSON.stringify(window.__tabterm.paneIds().map((p) => window.__tabterm.readScreen(p)))',
  ),
);
r.ok(
  'and its output is here now',
  screens.some((s) => s.includes('TAKEN-OVER-MARKER')),
);

/**
 * In the pane that offered, not beside it.
 *
 * Bringing a session used to split the empty pane, so the untouched shell stayed on screen next
 * to the session that was asked for, and the chooser that would have fixed it was gone with the
 * pane no longer being empty. Two panes here: the one this tab was used in, and the one taken
 * over. Three means it split.
 */
const paneCount = JSON.parse(
  await evaluate(b.client, 'JSON.stringify(window.__tabterm.paneIds())'),
).length;
r.ok(
  'it took the empty pane over rather than splitting it',
  paneCount === 2,
  `${String(paneCount)} panes`,
);

/**
 * A reload does not put the start screen back over a tab that has started something.
 *
 * The decision used to be made from the layout, and panes closed back to a single home-directory
 * shell are indistinguishable from a tab nobody used. This tab has two panes and a session that
 * was brought into it, and it must come back as a terminal.
 */
await evaluate(b.client, 'location.reload()');
await sleep(5000);
const cameBack = await waitFor(b.client, 'window.__tabterm?.paneIds().length > 0', 20000);
const launcherBack = Number(
  await evaluate(b.client, "document.querySelectorAll('.launcher-input').length"),
);
r.ok(
  'reloading a tab that has been used does not bring the start screen back',
  cameBack && launcherBack === 0,
  `${String(launcherBack)} start screens after reload`,
);

/**
 * Taking a session out of a tab that has others leaves that tab open and one pane lighter.
 *
 * The case above is the source tab holding nothing else, where the tab closes. This is the other
 * one, and it was asked about directly: "what if it's in a tab with other sessions? then it
 * should still be removed from that original tab if brought in."
 */
{
  const c = await openTerminal();
  await waitFor(c.client, "document.querySelector('.launcher-input')");
  await type(c.client, 'echo DONOR-TAB\r');
  await sleep(1500);
  // Two panes, both used, so neither is an untouched shell the chooser would leave out.
  await evaluate(c.client, "window.__tabterm.split('horizontal')");
  await sleep(3000);
  await type(c.client, 'echo DONOR-SECOND\r');
  await sleep(1500);
  const donorWorkspace = String(await evaluate(c.client, 'window.__tabterm.workspaceId()'));
  const donorPanes = Number(await evaluate(c.client, 'window.__tabterm.paneIds().length'));
  r.ok('the donor tab has two panes to begin with', donorPanes === 2, String(donorPanes));

  const taker = await openTerminal();
  await waitFor(taker.client, "document.querySelector('.launcher-input')");
  await type(taker.client, 'echo TAKER-TAB\r');
  await sleep(1500);
  await evaluate(taker.client, "window.__tabterm.split('horizontal')");
  await sleep(3500);
  // The button says what is behind it, so a short list is not read as a broken one.
  const counted = String(
    await evaluate(
      taker.client,
      "document.querySelector('.pane-chooser-take-count')?.textContent ?? ''",
    ),
  );
  r.ok(
    'the button says whether what it holds is in a tab or in the background',
    /in a tab|in tabs|in the background/.test(counted),
    counted,
  );
  await realClick(taker.client, '.pane-chooser-take');
  await waitFor(
    taker.client,
    "document.querySelectorAll('.take-bubble .pane-chooser-session').length > 0",
    20000,
  );

  // Take one of the donor tab's two sessions.
  const took = String(
    await evaluate(
      taker.client,
      `(() => {
         const rows = [...document.querySelectorAll('.pane-chooser-session')];
         const row = rows.find((x) => (x.textContent ?? '').includes('DONOR')) ?? rows[0];
         if (!row) return '';
         row.click();
         return row.dataset.session ?? '';
       })()`,
    ),
  );
  await sleep(700);
  // It is open in a tab, so it asks first. Confirmed with a real press.
  await realClick(taker.client, '.pane-chooser-session.is-confirming');
  await sleep(4000);

  const stillOpen = (await listTargets()).filter((t) => t.url.includes(donorWorkspace));
  r.ok('the donor tab is still open, because it had another pane', stillOpen.length === 1, took);
  const left = Number(await evaluate(c.client, 'window.__tabterm.paneIds().length'));
  r.ok('and it is one pane lighter', left === 1, String(left));
}

await finish();
r.done();
