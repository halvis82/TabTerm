// A shortcut row is one line: its name, its keys, and a quiet way to take the keys away.
//
// Reported with a screenshot: the clear button had no rule of its own, so it fell into the first
// column of a two column grid and became a full width bar under every shortcut, as big as the
// thing it belonged to and five of them down the page.
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await waitFor(client, `!document.querySelector('.cmd-panel')?.hidden`, 8000);
await evaluate(client, `document.querySelector('.cmd-gear')?.click()`);
await waitFor(client, `!!document.querySelector('.set-key-row')`, 8000);
await sleep(400);

const rows = JSON.parse(
  await evaluate(
    client,
    `(() => {
       const out = [];
       for (const row of document.querySelectorAll('.set-key-row')) {
         const keys = row.querySelector('.set-key');
         const clear = row.querySelector('.set-key-clear');
         if (!keys || !clear || clear.hidden) continue;
         const k = keys.getBoundingClientRect();
         const c = clear.getBoundingClientRect();
         const w = row.getBoundingClientRect();
         out.push({
           sameLine: Math.abs(k.top - c.top) < 6,
           clearWidth: Math.round(c.width),
           rowWidth: Math.round(w.width),
           keysWidth: Math.round(k.width),
         });
       }
       return JSON.stringify(out.slice(0, 4));
     })()`,
  ),
);

r.ok('there are shortcuts with a shortcut to clear', rows.length > 0, JSON.stringify(rows));
r.ok(
  'the clear sits on the same line as the keys it clears',
  rows.every((x) => x.sameLine),
  JSON.stringify(rows),
);
r.ok(
  'and is an aside rather than a bar across the row',
  rows.every((x) => x.clearWidth < x.rowWidth / 3),
  JSON.stringify(rows),
);
r.ok(
  'and is not bigger than the keys it belongs to',
  rows.every((x) => x.clearWidth <= x.keysWidth),
  JSON.stringify(rows),
);

await finish();
r.done();
