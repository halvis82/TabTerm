// The command palette is the primary surface: every action reachable by typing.
import {
  openTerminal,
  openPalette,
  pressInPalette,
  evaluate,
  sleep,
  paneCount,
  finish,
} from '../helpers.mjs';
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

const pageError = String(
  await evaluate(client, `window.__tabterm ? 'hook present' : 'no hook: the page failed to start'`),
);
r.ok('the page finished starting', pageError === 'hook present', pageError);
const all = await query('');
r.ok('actions lead the list', all.length >= 5, `${String(all.length)} actions`);
/**
 * A hint only where Chrome says a key is really bound.
 *
 * These used to be written into the table by hand, so one advertised Option Shift T for a
 * command that had since been rebound to something else, which is worse than saying nothing.
 * They come from `chrome.commands.getAll` now, and a fresh profile has bound almost nothing, so
 * what is checked is that nothing claims a key it does not have.
 */
// A hint may be a keystroke or a description. What must not happen is a keystroke being claimed
// for a command Chrome has not bound, so what is checked is that none of these carries one.
const keystrokes = all.filter((a) => /[⌘⌃⌥⇧]/.test(a.hint ?? ''));
r.ok(
  'no action claims a keystroke Chrome has not bound',
  keystrokes.length === 0,
  JSON.stringify(keystrokes.map((a) => `${a.title}=${a.hint ?? ''}`)),
);
r.ok(
  'the two that act on a particular pane are not offered from the keyboard',
  !all.some((a) => a.title === 'Maximize this pane' || a.title === 'Move this pane to its own tab'),
  all.map((a) => a.title).join(', '),
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

/**
 * Clicking an action does it. Clicking a command does not.
 *
 * They are different things and they behave differently on purpose. A history row is text, and
 * pasting or running somebody's old command because the pointer landed slightly wrong is a real
 * cost. An action is a button with a verb on it, and a button you have to select and then press
 * Enter is a button that does not work.
 */
await query('Split right');
await evaluate(client, `document.querySelector('.palette-row.is-action')?.click()`);
await sleep(3000);
r.ok(
  'clicking an action runs it',
  (await paneCount(client)) === 2,
  `${String(await paneCount(client))} panes`,
);

await openPalette(client);
await sleep(600);
await query('Split down');
await pressInPalette(client, 'Enter', 'Enter', 0, 13);
await sleep(3000);
r.ok(
  'and Enter still runs the selected one, so the keyboard path is unchanged',
  (await paneCount(client)) === 3,
  `${String(await paneCount(client))} panes`,
);

/**
 * Actions somebody made, beside the ones that ship.
 *
 * `Launch an agent in a new tab` used to be a built-in that ran whatever was configured, which
 * made the one thing most people want to change the one thing they could not.
 */
await evaluate(
  client,
  `chrome.storage.local.set({ 'tabterm.actions': [{ id: 'probe', name: 'say hello', kind: 'command', command: 'echo hello', where: 'new-tab', description: 'prints a greeting' }] })`,
);
await evaluate(client, 'location.reload()');
await sleep(4500);
await openPalette(client);
await sleep(900);

const withCustom = await query('');
const mine = withCustom.find((a) => a.title === 'say hello');
r.ok(
  'an action somebody made is offered',
  Boolean(mine),
  withCustom.map((a) => a.title).join(', '),
);
r.ok(
  'and says what it does without being opened',
  (mine?.hint ?? '').includes('greeting'),
  mine?.hint ?? '',
);
/**
 * The groups, because they answer different questions.
 *
 * A flat list put `Make an action` between two things that do something, looking exactly like
 * them, and put what somebody had written among what ships.
 */
const headings = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.palette-heading')].map((h) => h.textContent))`,
  ),
);
r.ok(
  'the actions are grouped, and the groups are labelled',
  headings.length >= 2 && headings.some((h) => /made/i.test(h)),
  JSON.stringify(headings),
);
r.ok(
  'a heading is never what Enter would run',
  !String(
    await evaluate(client, `document.querySelector('.palette-row.selected')?.className ?? ''`),
  ).includes('heading'),
);

r.ok(
  'there is a way to make one',
  withCustom.some((a) => a.title === 'Make an action'),
  withCustom.map((a) => a.title).join(', '),
);

// The pencil and the cross belong only to the ones that are yours.
const controls = JSON.parse(
  await evaluate(
    client,
    `(() => {
       const rows = [...document.querySelectorAll('.palette-row.is-action')];
       const mine = rows.find((el) => el.textContent.includes('say hello'));
       const builtin = rows.find((el) => el.textContent.includes('Split right'));
       return JSON.stringify({
         mine: Boolean(mine?.querySelector('.palette-action-edit')),
         builtin: Boolean(builtin?.querySelector('.palette-action-edit')),
       });
     })()`,
  ),
);
r.ok(
  'only a custom action offers editing and deleting',
  controls.mine && !controls.builtin,
  JSON.stringify(controls),
);

await finish();
r.done();
