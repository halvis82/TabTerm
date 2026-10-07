// A server's row on the start screen shows what the server is, and opening it is a button.
//
// The page behind a port used to appear only while a close was being confirmed, so the one way
// to see what a server was happened to be the button that stops it. Reported as having to press
// close to get the preview. A click on the row shows it now, and Open is the chip beside it.
import { openTerminal, evaluate, sleep, finish, waitFor, type, interrupt } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const PORT = 18000 + Math.floor(Math.random() * 1000);

// A server, in a tab that then goes to the background.
const donor = await openTerminal();
await waitFor(donor.client, "document.querySelector('.launcher-input')");
await type(donor.client, `python3 -m http.server ${String(PORT)} --bind 127.0.0.1`);
await sleep(2500);

const here = await openTerminal();
await waitFor(here.client, "document.querySelector('.launcher-input')");
const rowFor = `[...document.querySelectorAll('.launcher-row')].find((b) => b.textContent.includes('localhost:${String(PORT)}'))`;
r.ok('the server is listed on the start screen', await waitFor(here.client, rowFor, 20000));

const chips = async () =>
  JSON.parse(
    await evaluate(
      here.client,
      `JSON.stringify([...(${rowFor})?.parentElement.querySelectorAll('.launcher-chip') ?? []].map((c) => c.textContent))`,
    ),
  );
r.ok(
  'with Open as a button beside the row',
  (await chips()).includes('Open'),
  (await chips()).join(' | '),
);

const previewShown = () =>
  evaluate(here.client, `!!(${rowFor})?.parentElement.querySelector('.launcher-port-preview')`);
r.ok('nothing is previewed before the row is pressed', !(await previewShown()));

await evaluate(here.client, `(${rowFor})?.click()`);
r.ok(
  'pressing the row shows the page behind the port',
  await waitFor(
    here.client,
    `!!(${rowFor})?.parentElement.querySelector('.launcher-port-preview')`,
    5000,
  ),
);
r.ok(
  'pointed at that port',
  (await evaluate(
    here.client,
    `(${rowFor})?.parentElement.querySelector('.launcher-port-preview')?.src ?? ''`,
  )) === `http://localhost:${String(PORT)}/`,
);
r.ok(
  'and sandboxed with no permissions at all',
  (await evaluate(
    here.client,
    `(${rowFor})?.parentElement.querySelector('.launcher-port-preview')?.getAttribute('sandbox')`,
  )) === '',
);
await evaluate(here.client, `(${rowFor})?.click()`);
r.ok(
  'pressing it again puts the preview away',
  await waitFor(
    here.client,
    `!(${rowFor})?.parentElement.querySelector('.launcher-port-preview')`,
    5000,
  ),
);

await interrupt(donor.client);
await sleep(500);
await finish();
r.done();
