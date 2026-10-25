// A program copying to the clipboard (OSC 52), and the bell.
//
// Asked for after "programs can't copy to your clipboard": vim, tmux and anything over ssh copy by
// asking the terminal, and TabTerm ignored it. And "add support for" the bell. Neither may happen
// again when a reload puts the saved screen back, and a program may never read the clipboard.
import { openTerminal, evaluate, waitFor, sleep, finish, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo program-copy-suite');
await waitFor(client, "document.querySelector('.launcher')?.hidden === true", 10000);
await sleep(600);

const paneId = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
)[0];
const copies = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.programCopies())')));
const bells = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.bellsRung())')));
const setting = (key, value) =>
  evaluate(client, `chrome.storage.local.set({ ${JSON.stringify(key)}: ${value} })`);

// What vim does with "+y: the text, in base64, in OSC 52.
await type(client, "printf '\\033]52;c;%s\\a' \"$(printf 'copied-by-vim' | base64)\"");
r.ok(
  'a program copying puts its text on the clipboard',
  await waitFor(
    client,
    "window.__tabterm.programCopies().some((c) => c.text === 'copied-by-vim' && c.ok)",
    5000,
  ),
  JSON.stringify(await copies()),
);
r.ok(
  'and says so',
  String(await evaluate(client, "document.getElementById('status')?.textContent ?? ''")).includes(
    'copied-by-vim',
  ),
);

// Asking for the clipboard back is never answered.
const before = (await copies()).length;
await type(client, "printf '\\033]52;c;?\\a'; sleep 0.5; echo after-read-request");
await sleep(1200);
r.ok('a request to read the clipboard copies nothing', (await copies()).length === before);

// Turned off in Settings, a copy does nothing.
await setting('tabterm.programsMayCopy', false);
await sleep(200);
await type(client, "printf '\\033]52;c;%s\\a' \"$(printf 'not-copied' | base64)\"");
await sleep(1000);
r.ok(
  'with the setting off, nothing is copied',
  !(await copies()).some((c) => c.text === 'not-copied'),
);
await setting('tabterm.programsMayCopy', true);

// The bell, once, however many rang at once.
await type(client, "printf '\\a\\a\\a'");
r.ok(
  'the bell rings on the pane',
  await waitFor(client, `window.__tabterm.bellsRung().includes(${JSON.stringify(paneId)})`, 4000),
);
r.ok(
  'and the pane flashes',
  await waitFor(client, "document.querySelector('.pane.bell-ring') !== null", 1000),
);
await sleep(600);
r.ok('three bells at once ring once', (await bells()).length === 1, JSON.stringify(await bells()));
r.ok(
  'and the flash goes by itself',
  await waitFor(client, "document.querySelector('.pane.bell-ring') === null", 2000),
);

await setting('tabterm.showBell', false);
await sleep(200);
await type(client, "printf '\\a'");
await sleep(800);
r.ok('with the bell turned off, nothing shows', (await bells()).length === 1);
await setting('tabterm.showBell', true);

// A reload puts the screen back, and is not the program copying or ringing again.
await client.send('Page.reload');
await waitFor(client, 'window.__tabterm?.paneIds().length === 1', 25000);
await sleep(2500);
r.ok(
  'a reload copies nothing again',
  (await copies()).length === 0,
  JSON.stringify(await copies()),
);
r.ok('and rings no bell', (await bells()).length === 0, JSON.stringify(await bells()));

await finish();
r.done();
