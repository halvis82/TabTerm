// One way to find a folder: a list under the box, filtered by what is typed.
import { openTerminal, evaluate, sleep, finish, waitFor, realClick } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

const names = () =>
  evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.launcher-completion')].map((b) => b.textContent))`,
  );
const boxValue = () => evaluate(client, "document.querySelector('.launcher-input').value");
const typeInBox = async (text) => {
  await evaluate(
    client,
    `(() => { const i = document.querySelector('.launcher-input'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(900);
};

r.ok(
  'there is no Browse button to press',
  !(await evaluate(client, "!!document.querySelector('.launcher-browse')")),
);
const shown = await waitFor(
  client,
  "document.querySelectorAll('.launcher-completion').length > 1",
  8000,
);
r.ok('the folders are simply there, before anything is typed', shown);

const home = JSON.parse(await names());
r.ok('listing the home directory', home.includes('Documents'), JSON.stringify(home.slice(0, 6)));

// Typing filters what is already there, with no round trip.
await typeInBox('Doc');
const filtered = JSON.parse(await names());
r.ok(
  'typing filters the list',
  filtered.every((n) => n === '..' || n.toLowerCase().startsWith('doc')),
  JSON.stringify(filtered),
);

// Clicking one builds the path and leaves the cursor where the next name goes.
await realClick(client, '.launcher-completion', 'Documents');
await sleep(1200);
r.ok(
  'clicking a folder fills the box, with a trailing slash',
  String(await boxValue()) === 'Documents/',
  String(await boxValue()),
);
r.ok(
  'and leaves the box focused, at the end',
  (await evaluate(client, "document.activeElement?.className ?? ''")).includes('launcher-input'),
);
const inside = await waitFor(
  client,
  "document.querySelectorAll('.launcher-completion').length > 0",
  8000,
);
r.ok('and the list moves to what is inside it', inside, await names());

// The validity line follows along.
r.ok(
  'the folder is reported as existing',
  String(
    await evaluate(client, "document.querySelector('.launcher-folder-state')?.textContent ?? ''"),
  ).includes('exists'),
);

// `..` goes back up.
await realClick(client, '.launcher-completion', '..');
await sleep(1000);
r.ok('and `..` goes back up', String(await boxValue()) === '', String(await boxValue()));

await finish();
r.done();
