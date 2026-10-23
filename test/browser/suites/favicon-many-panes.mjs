// One icon for a tab of several panes, and an icon that says the same thing before and after a
// reload.
//
// Asked for as a split icon: "if there are multiple agents working for example and one finishes
// and the other still works ... one shows the green checkmark and one shows still working. ...
// when they're all done, it can just show one solid checkmark." And reported alongside it: "i
// keep seeing the loading icon ... just inconsistently. and it changes when i reload the page".
// Driven through the real hook bridge and real input, the way agent-favicon does it.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo MANY-PANES\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('MANY-PANES')`, 20000);
await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1500);

const port = Number(process.env['TT_DAEMON_PORT'] ?? '7377') + 1;
const token = process.env['TT_DAEMON_TOKEN'] ?? '';
const panes = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')),
);
r.ok('two panes, each with a session', panes.length === 2, JSON.stringify(panes));
const [a, b] = panes;

const hook = async (pane, name) => {
  const res = await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
    method: 'POST',
    headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: pane.sessionId, hook: name }),
  });
  if (res.status !== 204) throw new Error(`${name} answered ${String(res.status)}`);
  await sleep(500);
};
const icon = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.faviconNow())')));
const picture = async () => (await icon()).picture.join('+');
const reload = async () => {
  await evaluate(client, 'location.reload()');
  await sleep(3000);
  await waitFor(client, 'window.__tabterm?.paneIds().length === 2', 25000);
  await sleep(1500);
};

await hook(a, 'UserPromptSubmit');
await hook(b, 'UserPromptSubmit');
r.ok('two agents working is two rings', (await picture()) === 'running+running', await picture());

await hook(a, 'Stop');
r.ok(
  'one finished beside one working is a split: tick and ring',
  (await picture()) === 'success+running',
  await picture(),
);

await hook(b, 'Stop');
r.ok('both finished is two ticks', (await picture()) === 'success+success', await picture());

await evaluate(client, 'window.__tabterm.lookAtTab()');
await sleep(300);
r.ok(
  'and looking at the tab clears both to plain halves',
  (await picture()) === 'idle+idle',
  await picture(),
);

/*
 * An interrupt ends the turn, and nothing else ever says so.
 *
 * The agent fires no hook when somebody presses Escape, so the daemon went on believing it was
 * working: the ring spun over an agent sitting at its prompt, and a reload brought it back.
 */
await hook(b, 'UserPromptSubmit');
r.ok('a new turn spins in its half', (await picture()) === 'running+idle', await picture());
await evaluate(client, `window.__tabterm.sendInput(${JSON.stringify(b.paneId)}, '\\u001b')`);
await sleep(800);
r.ok('Escape stops the ring', (await picture()) === 'idle+idle', await picture());
await reload();
r.ok('and a reload agrees', (await picture()) === 'idle+idle', await picture());

/*
 * Before and after a reload say the same thing.
 *
 * A command still running spun before a refresh and sat idle after it, because only the live
 * start of a command set it running and a reload never sees one.
 */
await evaluate(client, `window.__tabterm.focus(${JSON.stringify(a.paneId)})`);
await evaluate(client, `window.__tabterm.sendInput(${JSON.stringify(a.paneId)}, 'sleep 60\\r')`);
await waitFor(client, `window.__tabterm.faviconNow().picture.join('+') === 'running+idle'`, 10000);
r.ok('a long command spins in its half', (await picture()) === 'running+idle', await picture());
await reload();
r.ok('and still spins after a reload', (await picture()) === 'running+idle', await picture());

await hook(b, 'UserPromptSubmit');
await reload();
r.ok(
  'a working agent beside it is two rings after a reload',
  (await picture()) === 'running+running',
  await picture(),
);
await hook(b, 'Stop');
r.ok(
  'and when it finishes, the split comes back',
  (await picture()) === 'success+running',
  await picture(),
);

await evaluate(client, `window.__tabterm.sendInput(${JSON.stringify(a.paneId)}, '\\u0003')`);
await finish();
r.done();
