// The command palette is the primary surface: every action reachable by typing.
import { openTerminal, openPalette, evaluate, sleep, paneCount } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await openPalette(client);
await sleep(800);

r.ok(
  'the palette opens',
  (await evaluate(client, `!document.querySelector('.palette').hidden`)) === true,
);

const scopes = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.palette-scope')].map(b => b.textContent))`,
  ),
);
r.ok('history scopes are offered as clicks', scopes.length === 4, scopes.join(' | '));

const query = async (text) => {
  await evaluate(
    client,
    `(() => { const i = document.querySelector('.palette-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(600);
  return JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.palette-row.is-action')].map(a => ({
        title: a.querySelector('.palette-command')?.textContent,
        hint: a.querySelector('.palette-meta')?.textContent,
      })))`,
    ),
  );
};

const all = await query('');
r.ok('actions lead the list', all.length >= 5, `${String(all.length)} actions`);
r.ok(
  'each shows its keystroke where one exists',
  all.some((a) => a.hint?.includes('⌘')),
);

const fuzzy = await query('sp');
r.ok(
  'a subsequence finds an action',
  fuzzy.some((a) => a.title === 'Split right'),
  fuzzy.map((a) => a.title).join(', '),
);

const single = await query('pane');
r.ok(
  'actions needing two panes are absent with one',
  !single.some((a) => a.title === 'Close this pane'),
  single.map((a) => a.title).join(', '),
);

// Running one from the palette must actually do it.
await query('Split right');
await evaluate(client, `document.querySelector('.palette-row.is-action')?.click()`);
await sleep(3000);
r.ok(
  'running an action from the palette works',
  (await paneCount(client)) === 2,
  `${String(await paneCount(client))} panes`,
);

r.done();
