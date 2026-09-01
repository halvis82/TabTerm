// An empty pane offers somewhere to go, rather than a bare prompt.
//
// Splitting used to produce two empty shells in the home directory, and the first thing anybody
// does with one is go somewhere. So a pane with nothing in it offers the two things worth doing:
// pick a folder, or bring a session that already exists here.
import { openTerminal, evaluate, sleep, type, finish } from '../helpers.mjs';
import { listTargets, reporter } from '../cdp.mjs';

const r = reporter();

// One tab holding a session that has actually been used, left open.
const a = await openTerminal();
await sleep(4500);
await type(a.client, 'echo TAKEN-OVER-MARKER\r');
await sleep(1600);
const sourceWorkspace = String(await evaluate(a.client, 'window.__tabterm.workspaceId()'));
const sourceSession = String(
  await evaluate(a.client, 'JSON.parse(window.__tabterm.transport()).panes[0].sessionId'),
);

const b = await openTerminal();
await sleep(4500);
await evaluate(b.client, "window.__tabterm.split('horizontal')");
await sleep(3500);

r.ok(
  'both panes of a split offer a chooser',
  Number(await evaluate(b.client, "document.querySelectorAll('.pane-chooser-box').length")) === 2,
);

// Tab completes a folder, exactly as it does on the start screen.
const key = (k) => `(() => {
  const i = document.querySelector('.pane-chooser-input');
  i.focus();
  i.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }));
})()`;
await evaluate(
  b.client,
  "(() => { const i = document.querySelector('.pane-chooser-input'); i.focus(); i.value = '~/Docu'; })()",
);
await evaluate(b.client, key('Tab'));
await sleep(1400);
const completed = String(
  await evaluate(b.client, "document.querySelector('.pane-chooser-input')?.value ?? ''"),
);
r.ok('Tab completes a path in the pane', completed.startsWith('~/Documents'), completed);

// A session already open in a tab says so before it is moved.
// Exactly the session this suite opened, not whichever attached row happens to be first: a
// machine mid-session has others, and taking one of those proves nothing about this behaviour.
// Matched on the prefix, because the test hook reports ids shortened for readability.
const clickAttached = `(() => {
  const row = document.querySelector('.pane-chooser-session[data-session^="${sourceSession}"]');
  if (!row) return '';
  row.click();
  return row.textContent;
})()`;
const clicked = String(await evaluate(b.client, clickAttached));
r.ok(
  'a session open in a tab is marked as such',
  clicked.includes('open in a tab'),
  clicked.slice(0, 40),
);

await sleep(700);
const warned = String(
  await evaluate(b.client, "document.querySelector('.pane-chooser-warn')?.textContent ?? ''"),
);
r.ok('and asks before taking it', warned.includes('close that tab'), warned);

const before = (await listTargets()).filter((t) => t.url.includes('terminal.html')).length;
await evaluate(b.client, "document.querySelector('.pane-chooser-session.is-confirming')?.click()");
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

await finish();
r.done();
