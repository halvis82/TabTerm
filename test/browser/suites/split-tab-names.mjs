// A tab of several panes is called by the names given to them.
//
// Asked for in these words: "when there are 2 named sessions in a tab, the title is just 2 panes ·
// 1 running. why don't i see the title i set for any of them? the running is already shown by the
// icon". So the title lists the names, and running is left to the icon.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo first-pane\r');
await evaluate(client, "window.__tabterm.split('horizontal')");
await sleep(2500);
await type(client, 'sleep 30\r');
const facts = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneFacts())')));
await waitUntil(async () => (await facts()).length === 2, 15000);
const panes = await facts();
r.ok('two panes in the tab', panes.length === 2);
const [a, b] = panes;
await evaluate(client, `window.__tabterm.setPaneLabel(${JSON.stringify(a?.paneId)}, 'training')`);
await evaluate(client, `window.__tabterm.setPaneLabel(${JSON.stringify(b?.paneId)}, 'eval')`);
const title = () => evaluate(client, 'document.title').then(String);
r.ok(
  'the tab is called by both names',
  await waitUntil(async () => /^training · eval\b/.test(await title()), 10000),
  await title(),
);
r.ok(
  'and does not count panes or say what is running',
  !/panes|running/.test(await title()),
  await title(),
);
await finish();
r.done();
