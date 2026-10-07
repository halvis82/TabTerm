// Right-click entries that made no sense in some state, and now say so or do the right thing.
//
// Two reports. A custom action that opens a template replaced the tab it ran in: three fresh
// shells over the session that was there, still listed as open in a tab and reachable from
// nowhere. And Clear was offered in an agent session, where it wipes the agent's own screen.
import { openTerminal, evaluate, sleep, finish, waitFor, type, openPaneMenu } from '../helpers.mjs';
import { listTargets, reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo menus-make-sense');
await waitFor(client, "document.querySelector('.launcher')?.hidden === true", 10000);
await sleep(600);

const panes = async () =>
  JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())'));
const [original] = await panes();
r.ok('the tab has a session with work in it', original?.sessionId !== undefined);

// A template beside this pane: new panes, the old one untouched, the keyboard on a new one.
await evaluate(
  client,
  `window.__tabterm.runCustomAction({ id: 'a-1', name: 'one plus two here', kind: 'template', where: 'split', templateId: 'default-one-plus-two' })`,
);
r.ok(
  'a template beside this pane adds its panes',
  await waitFor(client, "document.querySelectorAll('.pane').length === 4", 15000),
  String(await evaluate(client, "document.querySelectorAll('.pane').length")),
);
const after = await panes();
r.ok(
  'and the session that was here is still here, in its pane',
  after.some((p) => p.sessionId === original.sessionId && p.paneId === original.paneId),
  JSON.stringify(after),
);
const focused = await evaluate(client, 'window.__tabterm.focusedPane()');
r.ok(
  'with the keyboard on one of the new panes',
  focused !== original.paneId && after.some((p) => p.paneId === focused),
  `${String(focused)} vs ${String(original.paneId)}`,
);

// A template in a new tab: this tab is left exactly as it is.
const tabsBefore = (await listTargets()).filter((t) => t.type === 'page').length;
await evaluate(
  client,
  `window.__tabterm.runCustomAction({ id: 'a-2', name: 'one plus two elsewhere', kind: 'template', where: 'new-tab', templateId: 'default-one-plus-two' })`,
);
await sleep(2500);
const tabsAfter = (await listTargets()).filter((t) => t.type === 'page').length;
r.ok(
  'a template in a new tab opens one',
  tabsAfter > tabsBefore,
  `${String(tabsBefore)} -> ${String(tabsAfter)}`,
);
r.ok(
  'and leaves this tab exactly as it was',
  Number(await evaluate(client, "document.querySelectorAll('.pane').length")) === 4 &&
    (await panes()).some((p) => p.sessionId === original.sessionId),
);

// Clear is greyed over an agent, through the real hook bridge, and offered over a shell.
const port = Number(process.env['TT_DAEMON_PORT'] ?? '7377') + 1;
const token = process.env['TT_DAEMON_TOKEN'] ?? '';
const entry = async (label) =>
  JSON.parse(
    await evaluate(
      client,
      `JSON.stringify((() => { const b = [...document.querySelectorAll('.term-menu-item')].find((x) => (x.firstChild?.textContent ?? x.textContent) === ${JSON.stringify(label)}); return b ? { there: true, enabled: !b.disabled } : { there: false }; })())`,
    ),
  );
await evaluate(client, `window.__tabterm.focus(${JSON.stringify(original.paneId)})`);
await sleep(200);
const box = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify((() => { const b = document.querySelector('[data-pane-id=${JSON.stringify(original.paneId)}]').getBoundingClientRect(); return { x: b.left + 40, y: b.top + 60 }; })())`,
  ),
);
await openPaneMenu(client, Math.round(box.x), Math.round(box.y));
r.ok(
  'Clear is offered over a shell',
  (await entry('Clear')).enabled === true,
  JSON.stringify(await entry('Clear')),
);
await evaluate(client, "document.querySelector('.term-menu')?.remove()");

const res = await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
  method: 'POST',
  headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: original.sessionId, hook: 'UserPromptSubmit' }),
});
r.ok('the hook bridge took the agent event', res.status === 204, String(res.status));
await sleep(500);
await openPaneMenu(client, Math.round(box.x), Math.round(box.y));
r.ok(
  'and greyed over an agent',
  (await entry('Clear')).enabled === false,
  JSON.stringify(await entry('Clear')),
);
r.ok(
  'while the entry is still there, so the menu keeps its shape',
  (await entry('Clear')).there === true,
);
await evaluate(client, "document.querySelector('.term-menu')?.remove()");

await finish();
r.done();
