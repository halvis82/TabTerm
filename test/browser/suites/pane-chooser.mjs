// An empty pane offers somewhere to go, rather than a bare prompt.
//
// Splitting used to produce two empty shells in the home directory, and the first thing anybody
// does with one is go somewhere. So a pane with nothing in it offers the two things worth doing:
// pick a folder, or bring a session that already exists here.
import { openTerminal, evaluate, sleep, type, finish, realClick } from '../helpers.mjs';
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

// The picker, which is what a pane cannot already do by typing. There is deliberately no path
// box: sitting at a prompt, typing a path is what `cd` is for.
await realClick(b.client, '.pane-chooser-browse');
await sleep(1600);
r.ok(
  'the picker lists folders',
  Number(await evaluate(b.client, "document.querySelectorAll('.pane-chooser-folder').length")) > 1,
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

await realClick(b.client, '.pane-chooser-cancel', 'Cancel');
await sleep(500);

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

await finish();
r.done();
