// Templates: a folder, an arrangement, and a command per pane.
//
// Everything here is a defect somebody hit. The commands were typed before any shell had drawn a
// prompt, so they landed above it and belonged to nothing. A template opened in the folder it
// was saved from rather than the one in the box, so it was only usable in one project. And the
// templates sat in a strip of their own with no shortcut, no description and no way to edit one.
import { openTerminal, evaluate, sleep, finish, waitFor, readScreen } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

const labels = async () =>
  JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.launcher-buttons .launcher-chip')].map((c) => c.firstChild?.textContent ?? ''))`,
    ),
  );

/**
 * The defaults are ordinary templates in the same row as the layouts.
 *
 * `Open agent here` used to sit at the end doing something no template could express, which
 * meant the one thing most people wanted was the one thing they could not edit or reorder.
 */
const shown = await labels();
r.ok(
  'claude and codex are offered',
  shown.includes('claude') && shown.includes('codex'),
  JSON.stringify(shown),
);
r.ok('and the agent button that could not be edited is gone', !shown.includes('Open agent here'));
r.ok(
  'they are in the same row as the layouts, so they get the numbering',
  shown.indexOf('Open') === 0 && shown.indexOf('claude') > shown.indexOf('4 panes'),
  JSON.stringify(shown),
);

/** The row grows sideways rather than wrapping, so adding one never moves the page around. */
const row = JSON.parse(
  await evaluate(
    client,
    `(() => { const el = document.querySelector('.launcher-buttons'); const s = getComputedStyle(el); return JSON.stringify({ wrap: s.flexWrap, overflow: s.overflowX }); })()`,
  ),
);
r.ok(
  'the row scrolls sideways instead of wrapping',
  row.wrap === 'nowrap' && row.overflow === 'auto',
  JSON.stringify(row),
);

/**
 * The card, which is where a description has ever been visible.
 *
 * Reached by the `i`, because a card that only appears on hover is a card nobody knows about.
 */
await evaluate(
  client,
  `[...document.querySelectorAll('.launcher-template')].find((c) => c.textContent.includes('claude'))?.querySelector('.launcher-template-info')?.click()`,
);
await sleep(400);
const card = String(
  await evaluate(client, `document.querySelector('.template-card')?.innerText ?? ''`),
);
r.ok(
  'the info dot shows what the template is',
  card.includes('claude'),
  card.slice(0, 60).replace(/\n+/g, ' | '),
);
r.ok(
  'including the description, which was never visible anywhere before',
  /terminal running/i.test(card),
  card.slice(0, 80).replace(/\n+/g, ' | '),
);
r.ok(
  'and offers editing rather than only deleting',
  card.includes('Edit') && card.includes('Delete'),
);

// A template is draggable, which is what reorders it and renumbers its shortcut with it.
r.ok(
  'templates can be dragged to reorder',
  Boolean(
    await evaluate(
      client,
      `[...document.querySelectorAll('.launcher-template')].every((c) => c.draggable === true)`,
    ),
  ),
);

await evaluate(client, `document.querySelector('.template-card [class*="chip"]')?.blur()`);
await evaluate(client, `document.querySelector('.template-card')?.remove()`);

/**
 * Running one: in the folder from the box, and at a prompt rather than above it.
 *
 * `pwd` rather than the default `claude`, because whether Claude is installed is not what this
 * is about. The template is edited to run it, which also exercises editing in place.
 */
await evaluate(
  client,
  `(() => {
     const i = document.querySelector('.launcher-input');
     i.focus();
     i.value = '~/Documents';
     i.dispatchEvent(new Event('input', { bubbles: true }));
   })()`,
);
await sleep(500);

await evaluate(
  client,
  `chrome.storage.local.set({ 'tabterm.templates': [{ id: 'probe', name: 'probe', path: '~', shape: 'single', panes: 1, layout: '1', commands: ['pwd'], sessionCommands: { '1': 'pwd' }, description: 'prints where it is' }], 'tabterm.templatesSeeded': true })`,
);
await evaluate(client, 'location.reload()');
await sleep(4000);
await waitFor(client, "document.querySelector('.launcher-input')");
await evaluate(
  client,
  `(() => {
     const i = document.querySelector('.launcher-input');
     i.focus();
     i.value = '~/Documents';
     i.dispatchEvent(new Event('input', { bubbles: true }));
   })()`,
);
await sleep(600);
await evaluate(
  client,
  `[...document.querySelectorAll('.launcher-template')].find((c) => c.textContent.includes('probe'))?.click()`,
);

// Waited for, because the point is that the command runs once a prompt exists rather than before.
const ran = await waitFor(
  client,
  `(window.__tabterm.readScreen() ?? '').includes('/Documents')`,
  25000,
);
r.ok(
  'the command runs, in the folder from the box rather than the one it was saved in',
  ran,
  String(await readScreen(client))
    .split('\n')
    .filter(Boolean)
    .slice(-2)
    .join(' | '),
);

await finish();
r.done();
