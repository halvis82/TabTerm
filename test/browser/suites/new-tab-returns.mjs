// A new terminal opens at the end and closes back to the tab it was opened from.
//
// Asked for: "if you have 5 tabs open and you're on tab 3 and you open a new tab with cmd t that
// is opened as tab 6 ... and then if you close it, you don't go to tab 5 ... you go back to tab 3.
// can we make that the same behavior with tabterm". Driven through what the shortcut runs, in the
// service worker, since a test cannot press a browser-wide key.
import { openTerminal, evaluate, sleep, finish, waitUntil, EXT_ID } from '../helpers.mjs';
import { reporter, listTargets, connect } from '../cdp.mjs';

const r = reporter();
await openTerminal();
await sleep(1500);

async function inWorker(expression) {
  const worker = (await listTargets()).find(
    (t) => t.type === 'service_worker' && t.url.includes(EXT_ID),
  );
  if (!worker) return null;
  const sw = connect(worker.webSocketDebuggerUrl);
  await sw.ready;
  await sw.send('Runtime.enable');
  const value = await evaluate(sw, expression);
  sw.close?.();
  return value;
}
const strip = async () =>
  JSON.parse(
    String(
      await inWorker(
        `chrome.windows.getLastFocused({ populate: true }).then((w) => JSON.stringify(w.tabs.map((t) => ({ id: t.id, active: t.active }))))`,
      ),
    ),
  );
const activeId = async () => (await strip()).find((t) => t.active)?.id;

// Five tabs, with the third in front.
for (let i = 0; i < 4; i++) {
  await inWorker(`chrome.tabs.create({ url: 'about:blank', active: false }).then(() => 1)`);
}
await sleep(500);
const before = await strip();
const third = before[before.length - 3].id;
await inWorker(`chrome.tabs.update(${String(third)}, { active: true }).then(() => 1)`);
await sleep(300);
r.ok('a tab in the middle is in front', (await activeId()) === third);

await inWorker('__tabtermNewTerminal().then(() => 1)');
await waitUntil(async () => (await strip()).length === before.length + 1, 10000);
const after = await strip();
const opened = after[after.length - 1];
r.ok('the new terminal opens at the end', opened.active === true, JSON.stringify(after));

await inWorker(`chrome.tabs.remove(${String(opened.id)}).then(() => 1)`);
await sleep(500);
r.ok(
  'and closing it goes back to the tab it was opened from, not the last one',
  (await activeId()) === third,
  JSON.stringify(await strip()),
);

// Chrome forgets the opener once somebody switches tabs by hand, as it does for Cmd+T. That half
// is not checked here: a switch made through the tabs API is not a person's, and Chrome keeps the
// opener through it.

await finish();
r.done();
