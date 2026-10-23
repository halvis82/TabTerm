// How long a session has been alive, said in its pane's corner and counted from the session.
//
// Asked for: "can you also add session alive for x time ... persistent through refreshes. so it
// should track from when a tabterm terminal session is started, not anything with the tab.
// persistent regardless of whether it's moved to a different tab or whatever". The label itself
// is unit tested in elapsed.test.ts; this checks the start it counts from, in a real tab, across a
// split, a reload and a move to another tab.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { connect, listTargets, reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo ALIVE-CHECK\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('ALIVE-CHECK')`, 20000);

const starts = async (c) =>
  JSON.parse(String(await evaluate(c, 'JSON.stringify(window.__tabterm.paneStarts())')));
const bySession = (list) => Object.fromEntries(list.map((p) => [p.sessionId, p.startedAt]));

const first = await starts(client);
r.ok('the pane knows when its session started', first[0]?.startedAt > 0, JSON.stringify(first));

// A split makes a second session, which must know its own start too.
await sleep(1500);
await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1200);
const split = await starts(client);
r.ok(
  'a pane made by a split knows its own start, later than the first',
  split.length === 2 &&
    split.every((p) => p.startedAt > 0) &&
    new Set(split.map((p) => p.startedAt)).size === 2,
  JSON.stringify(split),
);
const known = bySession(split);

await client.send('Page.reload');
await waitFor(client, 'window.__tabterm?.paneIds().length === 2', 25000);
await sleep(1500);
const reloaded = bySession(await starts(client));
r.ok(
  'a reload keeps each start exactly, rather than restarting the count',
  Object.keys(known).every((id) => reloaded[id] === known[id]),
  JSON.stringify({ known, reloaded }),
);

// Moved to a tab of its own, it keeps counting from when it started.
const moving = split[1];
await evaluate(client, `window.__tabterm.focus(${JSON.stringify(moving.paneId)})`);
await sleep(300);
const before = new Set((await listTargets()).map((t) => t.id));
await evaluate(client, 'window.__tabterm.detachPane()');
await waitFor(client, 'window.__tabterm.paneIds().length === 1', 20000);
let target;
for (let i = 0; i < 40 && !target; i++) {
  target = (await listTargets()).find(
    (t) => !before.has(t.id) && (t.url ?? '').includes('terminal.html'),
  );
  if (!target) await sleep(250);
}
r.ok('the pane went to a tab of its own', target !== undefined);
if (target) {
  const other = connect(target.webSocketDebuggerUrl);
  await other.ready;
  await other.send('Runtime.enable');
  await waitFor(other, 'window.__tabterm?.paneIds().length === 1', 25000);
  await sleep(1200);
  const moved = bySession(await starts(other));
  r.ok(
    'and in its new tab it counts from the same start',
    moved[moving.sessionId] === known[moving.sessionId],
    JSON.stringify({ was: known[moving.sessionId], now: moved }),
  );
  await other.send('Page.close').catch(() => undefined);
}

await finish();
r.done();
