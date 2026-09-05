// One way to find a folder: a list under the box, filtered by what is typed.
import { openTerminal, evaluate, sleep, finish, waitFor, realClick } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

/**
 * The folder list sits as close to the row of things to open as every other pair on this screen.
 *
 * Reported several times as a band of empty space. Measured, the folders ended at 141 and the
 * buttons began at 175: a line about the folder in the box was holding eighteen pixels open for
 * a sentence it only shows while a path is being typed, with the parent's gap on both sides.
 *
 * Compared against the gap below the buttons rather than to a number, because what was asked for
 * was "like the space between the templates and Running now", and a number would be a second
 * copy of a spacing rule that lives in the stylesheet.
 *
 * Before anything is typed, deliberately. That line is meant to take room while somebody is
 * typing a path, because then it has something to say.
 */
const spacing = JSON.parse(
  await evaluate(
    client,
    `(() => {
       const folders = document.querySelector('.launcher-completions');
       const buttons = document.querySelector('.launcher-buttons');
       const state = document.querySelector('.launcher-folder-state');
       if (!folders || !buttons) return 'null';
       return JSON.stringify({
         gap: Math.round(buttons.getBoundingClientRect().top - folders.getBoundingClientRect().bottom),
         stateText: (state?.textContent ?? '').trim(),
         stateHeight: state ? Math.round(state.getBoundingClientRect().height) : -1,
       });
     })()`,
  ),
);
/**
 * The line about the folder takes no room when it has nothing to say.
 *
 * That is the whole of the fix and it is always there to look at, unlike the sections below,
 * which a machine with no running sessions does not draw at all: comparing against those made
 * this check pass or fail depending on what else was on the screen.
 */
r.ok(
  'the line about the folder takes no room while it has nothing to say',
  spacing !== null && spacing.stateText === '' && spacing.stateHeight === 0,
  JSON.stringify(spacing),
);
r.ok(
  'so the folders sit close to the row of things to open',
  spacing !== null && spacing.gap <= 14,
  JSON.stringify(spacing),
);

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

// `..` goes back up. Waited for: the box is rewritten after the daemon answers about the folder.
await realClick(client, '.launcher-completion', '..');
const wentUp = await waitFor(
  client,
  `(document.querySelector('.launcher-input')?.value ?? 'x') === ''`,
  15000,
);
r.ok('and `..` goes back up', wentUp, String(await boxValue()));

/**
 * A path typed several levels deep, without a tilde.
 *
 * `Documents/personal_coding/wif` found nothing. The daemon is started with a working directory
 * of `/`, so a relative path was resolved against the root rather than against home, and the
 * answer was an empty list with no error to explain it.
 *
 * Two levels, because one level is the case the box already handles on the way in. The second
 * level is discovered rather than written down, so this does not depend on any particular folder
 * existing on the machine running it.
 */
await typeInBox('Documents/');
const insideDocuments = JSON.parse(await names()).filter((n) => n !== '..');
const child = insideDocuments[0];
if (child === undefined) {
  r.ok('a relative path two levels down still lists', false, 'no folder inside ~/Documents');
} else {
  await typeInBox(`Documents/${child}/`);
  const deep = await waitFor(
    client,
    "document.querySelectorAll('.launcher-completion').length > 0",
    8000,
  );
  r.ok(`a relative path two levels down still lists (Documents/${child}/)`, deep, await names());
}

await finish();
r.done();
