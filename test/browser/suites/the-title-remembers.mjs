// A tab called by what it ran is still called that after a refresh.
//
// Reported as: "when the title for a tab is set to something like the last command run and then we
// refresh, it's just set to zsh. it shouldn't default to that, it should be persistent and
// remember." The page learned it from the event that says a command started, and a page that has
// just loaded has never received one.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

const marker = 'dmesg-lookalike';
await type(client, `echo ${marker}\r`);
await waitUntil(
  async () =>
    String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).includes(marker),
  20000,
);
await sleep(1200);

const named = await waitUntil(
  async () => String(await evaluate(client, 'document.title')).includes('echo'),
  10000,
);
r.ok('the tab is called by what it ran', named, String(await evaluate(client, 'document.title')));

await client.send('Page.reload');
await sleep(1000);
await waitUntil(
  async () => String(await evaluate(client, 'window.__tabterm?.readScreen?.() ?? ""')).length > 5,
  30000,
);
await sleep(1500);

const still = await waitUntil(
  async () => String(await evaluate(client, 'document.title')).includes('echo'),
  15000,
);
r.ok('and still is after a refresh', still, String(await evaluate(client, 'document.title')));
r.ok(
  'rather than falling back to the name of the shell',
  !/^zsh\b/.test(String(await evaluate(client, 'document.title'))),
  String(await evaluate(client, 'document.title')),
);

await finish();
r.done();
