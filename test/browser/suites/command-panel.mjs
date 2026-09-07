// The command panel: tabs, selection, double-click, dragging, minimizing.
//
// Selection and action are separate steps everywhere in this product, and this is the surface
// where that matters most: the list sits over a live terminal, and a click that pasted would
// mean you could never read a command before choosing it.
import {
  openTerminal,
  evaluate,
  readScreen,
  sleep,
  type,
  finish,
  waitFor,
  press,
  interrupt,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

/**
 * Make sure the panel is open, rather than clicking the button that toggles it.
 *
 * The button is a toggle, so clicking it to "open" the panel closes one that was already open,
 * and every check after that quietly runs against a panel that is not there. `waitFor` returns
 * false rather than throwing, so it does not even fail where the mistake was made.
 */
const openPanel = async () => {
  const hidden = await evaluate(client, `String(document.querySelector('.cmd-panel')?.hidden)`);
  if (String(hidden) !== 'false') {
    await evaluate(client, `document.getElementById('cmd-button')?.click()`);
  }
  return waitFor(client, `document.querySelector('.cmd-panel')?.hidden === false`, 8000);
};

// Give Recent something to hold.
const TAG = String(Date.now()).slice(-5);
for (const command of [`echo panel-${TAG}-one`, `echo panel-${TAG}-two`]) {
  await type(client, command);
  await sleep(700);
}

r.ok(
  'a button sits in the top right',
  (await evaluate(client, `!!document.getElementById('cmd-button')`)) === true,
);

await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await sleep(800);

r.ok(
  'clicking it opens the panel',
  (await evaluate(client, `!document.querySelector('.cmd-panel').hidden`)) === true,
);
r.ok(
  'with a tab for each kind of thing it holds',
  (await evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.cmd-tab')].map(t => t.textContent))`,
  )) === JSON.stringify(['Favorites', 'Recent', 'Actions', 'Stats']),
);
/**
 * Asked as "is any of it see-through", not "is it spelled rgba".
 *
 * The old check matched the string, which made it a check about notation: the colour is built
 * from the theme now, and `color-mix` computes to `color(srgb ...)` while being just as
 * translucent. A check that fails on a rewrite that changed nothing it cares about is noise.
 */
const panelAlpha = String(
  await evaluate(
    client,
    `(() => { const c = getComputedStyle(document.querySelector('.cmd-panel')).backgroundColor;
       // Every number in the value, whatever notation it is written in. The alpha is the last.
       const m = c.match(/[0-9]*\\.?[0-9]+/g) || [];
       return m.length >= 4 ? String(m[m.length - 1]) + ' of ' + c : '1 of ' + c; })()`,
  ),
);
r.ok(
  'and it is translucent, so output behind it stays readable',
  Number(panelAlpha.split(' ')[0]) < 1,
  `alpha ${panelAlpha}`,
);

// Recent tab.
await evaluate(
  client,
  `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Recent')?.click()`,
);
await sleep(600);

const rows = () =>
  evaluate(
    client,
    `JSON.stringify({
      count: document.querySelectorAll('.cmd-row').length,
      selected: [...document.querySelectorAll('.cmd-row')].findIndex(x => x.classList.contains('selected')),
      text: document.querySelector('.cmd-row.selected .cmd-row-label')?.textContent ?? null,
    })`,
  ).then((s) => JSON.parse(s));

const listed = await rows();
r.ok('Recent lists commands that were run', listed.count > 0, `${String(listed.count)} rows`);

// Clicking selects and does nothing else.
const before = await readScreen(client);
await evaluate(client, `document.querySelectorAll('.cmd-row')[1]?.click()`);
await sleep(400);
const clicked = await rows();
r.ok('a single click selects', clicked.selected === 1, `index ${String(clicked.selected)}`);
r.ok('and pastes nothing', (await readScreen(client)) === before);
r.ok(
  'the panel stays open',
  (await evaluate(client, `!document.querySelector('.cmd-panel').hidden`)) === true,
);
r.ok(
  'the footer names what the keys do for that row',
  String(await evaluate(client, `document.querySelector('.cmd-hints')?.textContent`)).includes(
    'Double-click',
  ),
  String(await evaluate(client, `document.querySelector('.cmd-hints')?.textContent`)),
);

// Double-click pastes without touching the clipboard.
await evaluate(client, `navigator.clipboard.writeText('CLIP-UNTOUCHED')`);
const chosen = clicked.text;
await evaluate(
  client,
  `(() => {
    const row = document.querySelectorAll('.cmd-row')[1];
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`,
);
await sleep(900);

const line = (await readScreen(client)).split('\n').filter(Boolean).pop() ?? '';
r.ok('double-click pastes the command', line.includes(chosen ?? ' '), line);
r.ok(
  'and leaves the clipboard alone',
  (await evaluate(client, `navigator.clipboard.readText()`)) === 'CLIP-UNTOUCHED',
);
// Pasted, not run: the command sits on the prompt line and nowhere else. Checking for the
// tagged echo instead would find the run that seeded history at the top of this suite.
const linesAfter = (await readScreen(client)).split('\n').filter(Boolean);
r.ok(
  'and does not run it',
  !linesAfter.some((each) => each.trim() === (chosen ?? '')),
  linesAfter.slice(-1)[0] ?? '',
);

// Dragging, and remembering where it was put. Reopen only if the paste closed it, rather than
// toggling blindly: clicking the button when it is already open closes it, and then the
// measurements below are of a hidden element.
await evaluate(
  client,
  `(() => { if (document.querySelector('.cmd-panel').hidden) document.getElementById('cmd-button')?.click(); })()`,
);
await sleep(700);
const start = JSON.parse(
  await evaluate(
    client,
    `(() => { const b = document.querySelector('.cmd-panel').getBoundingClientRect();
       return JSON.stringify({ x: Math.round(b.left), y: Math.round(b.top) }); })()`,
  ),
);
// Up and to the left. The panel opens anchored to the top right, so dragging down or right is
// pinned by the clamp that keeps it on screen, and in a small window that is no movement at all.
// A test that cannot tell "clamped correctly" from "drag is broken" is testing the window size.
await evaluate(
  client,
  `(() => {
    const header = document.querySelector('.cmd-header');
    const opts = { bubbles: true, clientX: 200, clientY: 200, pointerId: 1 };
    header.dispatchEvent(new PointerEvent('pointerdown', opts));
    header.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: 120, clientY: 150 }));
    header.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: 120, clientY: 150 }));
  })()`,
);
await sleep(500);
const moved = JSON.parse(
  await evaluate(
    client,
    `(() => { const b = document.querySelector('.cmd-panel').getBoundingClientRect();
       return JSON.stringify({ x: Math.round(b.left), y: Math.round(b.top) }); })()`,
  ),
);
r.ok(
  'the panel can be dragged',
  moved.x !== start.x || moved.y !== start.y,
  `${String(start.x)},${String(start.y)} -> ${String(moved.x)},${String(moved.y)}`,
);

const stored = await evaluate(
  client,
  `(async () => JSON.stringify((await chrome.storage.local.get('tabterm.panel'))['tabterm.panel'] ?? null))()`,
);
r.ok('and where it was put is remembered', String(stored).includes('"x"'), String(stored));

/**
 * Minimizing hides the panel, and the button that is always in the top right brings it back.
 *
 * There is deliberately no second control. It used to leave a small puck floating where the
 * panel had been, beside a permanent button that did the same thing: two controls for one
 * action, one of them in a place that moves.
 */
await evaluate(client, `document.querySelector('.cmd-header .cmd-icon')?.click()`);
await sleep(500);
r.ok(
  'minimizing hides it',
  (await evaluate(client, `document.querySelector('.cmd-panel').hidden`)) === true,
);
r.ok(
  'and leaves no second icon behind',
  (await evaluate(client, `document.querySelector('.cmd-puck') === null`)) === true,
);
await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await sleep(500);
r.ok(
  'the button in the corner brings it back',
  (await evaluate(client, `!document.querySelector('.cmd-panel').hidden`)) === true,
);

/**
 * The star keeps a command and takes it back out, and asks before the second one.
 *
 * It used to be one way only: a filled star that showed a state and refused to change it, which
 * is a control that lies. Asking first because it is small, sits beside a row people click to
 * paste, and the thing it removes was deliberately kept.
 */
{
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Recent')?.click()`,
  );
  await sleep(500);
  const firstStar = `document.querySelector('.cmd-row .cmd-star')`;
  const state = () => evaluate(client, `${firstStar}?.textContent ?? ''`);
  const had = String(await state());
  r.ok('a recent command offers a star', had === '★' || had === '☆', had);

  if (had === '☆') {
    await evaluate(client, `${firstStar}?.click()`);
    // Waited for rather than slept past: keeping a favorite is a round trip to the daemon, and
    // how long that takes is not this suite's business.
    const filled = await waitFor(
      client,
      `document.querySelector('.cmd-row .cmd-star')?.textContent === '\u2605'`,
      8000,
    );
    r.ok('starring it fills the star', filled, String(await state()));
  }

  await evaluate(client, `${firstStar}?.click()`);
  await waitFor(client, `!!document.querySelector('.cmd-ask')`, 6000);
  const asked = String(
    await evaluate(client, `document.querySelector('.cmd-ask')?.textContent ?? ''`),
  );
  r.ok(
    'pressing a filled star asks before removing it, rather than doing nothing',
    asked.toLowerCase().includes('remove'),
    asked.slice(0, 60),
  );
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-ask button')].find(b => /cancel/i.test(b.textContent))?.click()`,
  );
  await sleep(400);
  r.ok('and cancelling leaves it kept', String(await state()) === '★', String(await state()));
}

/**
 * Return pastes. It does not run.
 *
 * The pair used to be Return for "do this" and Command+Return for "give me this to edit", and it
 * was wrong: a list of old commands is a thing people read, and running one because Return was
 * the key under the finger cannot be taken back. Return is the same gesture a double-click makes
 * now, and the Return that runs a command is the one pressed at the prompt, looking at it.
 */
{
  /**
   * A command whose output differs from its own text, which is what makes this decidable.
   *
   * Running `echo paste-check-N` puts the word on the screen twice: once as the line that was
   * typed and once as what it printed. Pasting puts it there once. Counting is the difference
   * between "it went to the prompt" and "it went to the prompt and ran", and a check that only
   * looked for the text on screen could not tell those apart at all.
   */
  const tag = `paste-check-${String(Date.now()).slice(-6)}`;
  const count = async () => String(await readScreen(client)).split(tag).length - 1;
  await type(client, `echo ${tag}`);
  await sleep(1200);
  const ran = await count();
  r.ok('a command that ran leaves its name twice', ran === 2, String(ran));

  await openPanel();
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Recent')?.click()`,
  );
  await waitFor(client, `document.querySelector('.cmd-row') !== null`, 8000);
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-row')].find(el => (el.textContent ?? '').includes('${tag}'))?.click()`,
  );
  await sleep(400);
  await press(client, 'Enter', 'Enter', 0, 13, { focus: 'none' });
  await sleep(1500);
  const after = await count();
  r.ok(
    'Return puts the command at the prompt, and only there',
    after === ran + 1,
    `${String(after)} occurrences, was ${String(ran)}`,
  );
  // Leave the prompt clean for whatever runs next.
  await interrupt(client);
  await sleep(500);
}

/**
 * A favorite can be deleted from the list it lives in.
 *
 * The only way out was the filled star on its recent row, which exists only while the same
 * command is still in the history. Something kept months ago had no way out at all.
 */
{
  await openPanel();
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Favorites')?.click()`,
  );
  await sleep(500);
  const rows = () =>
    evaluate(client, `String(document.querySelectorAll('.cmd-row.is-favorite').length)`);
  const had = Number(await rows());
  if (had === 0) {
    r.skip('a favorite offers a way to delete it', 'nothing kept in this state');
  } else {
    r.ok(
      'a favorite has a cross beside its pencil',
      Boolean(
        await evaluate(client, `document.querySelector('.cmd-row.is-favorite .cmd-drop') !== null`),
      ),
    );
    await evaluate(client, `document.querySelector('.cmd-row.is-favorite .cmd-drop')?.click()`);
    await waitFor(client, `!!document.querySelector('.cmd-ask')`, 6000);
    r.ok(
      'and the panel keeps the keyboard while the question is up',
      String(
        await evaluate(
          client,
          `document.activeElement?.className || document.activeElement?.tagName`,
        ),
      ).includes('cmd-'),
      String(
        await evaluate(
          client,
          `document.activeElement?.className || document.activeElement?.tagName`,
        ),
      ),
    );
    r.ok(
      'and asks before deleting it',
      String(await evaluate(client, `document.querySelector('.cmd-ask')?.textContent ?? ''`))
        .toLowerCase()
        .includes('delete'),
    );

    /**
     * Escape takes the question away, and only the question.
     *
     * It closed the whole panel, so declining to delete something also threw away the list being
     * read, which is a steep price for saying no.
     */
    await press(client, 'Escape', 'Escape', 0, 27, { focus: 'none' });
    await sleep(400);
    const afterEscape = String(
      await evaluate(
        client,
        `JSON.stringify({ ask: document.querySelector('.cmd-ask') !== null, hidden: document.querySelector('.cmd-panel')?.hidden, active: document.activeElement?.className || document.activeElement?.tagName })`,
      ),
    );
    r.ok(
      'Escape closes the question and not the menu',
      afterEscape.includes('"ask":false') && afterEscape.includes('"hidden":false'),
      afterEscape,
    );
    r.ok('and the favorite is still there', Number(await rows()) === had, String(await rows()));

    // Return answers it, since the question was asked by the gesture just made.
    await evaluate(client, `document.querySelector('.cmd-row.is-favorite .cmd-drop')?.click()`);
    await waitFor(client, `!!document.querySelector('.cmd-ask')`, 6000);
    await press(client, 'Enter', 'Enter', 0, 13, { focus: 'none' });
    const gone = await waitFor(
      client,
      `document.querySelectorAll('.cmd-row.is-favorite').length === ${String(had - 1)}`,
      8000,
    );
    r.ok('and Return deletes it', gone, `${String(await rows())} left, was ${String(had)}`);
  }
}

/** A new command opens its own editor, since filling it in is the next thing either way. */
{
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Favorites')?.click()`,
  );
  await sleep(400);
  await evaluate(client, `document.querySelector('.cmd-add')?.click()`);
  const editing = await waitFor(client, `!!document.querySelector('.cmd-edit')`, 8000);
  r.ok(
    'adding a command opens the form for it',
    editing,
    String(
      await evaluate(
        client,
        `JSON.stringify({ hidden: document.querySelector('.cmd-panel')?.hidden, favorites: document.querySelectorAll('.cmd-row.is-favorite').length, add: document.querySelector('.cmd-add') !== null, edit: document.querySelector('.cmd-edit') !== null })`,
      ),
    ),
  );
}

/** A recent can be taken out of the list, which is only the record that it ran. */
{
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Recent')?.click()`,
  );
  await waitFor(client, `document.querySelector('.cmd-row.is-recent') !== null`, 8000);
  const count = () =>
    evaluate(client, `String(document.querySelectorAll('.cmd-row.is-recent').length)`);
  const had = Number(await count());
  r.ok(
    'a recent has a cross beside its star',
    Boolean(
      await evaluate(client, `document.querySelector('.cmd-row.is-recent .cmd-drop') !== null`),
    ),
  );
  await evaluate(client, `document.querySelector('.cmd-row.is-recent .cmd-drop')?.click()`);
  const fewer = await waitFor(
    client,
    `document.querySelectorAll('.cmd-row.is-recent').length < ${String(had)}`,
    8000,
  );
  r.ok(
    'and it goes, without being asked about',
    fewer,
    `${String(await count())}, was ${String(had)}`,
  );
}

/**
 * An action's controls are at the end of its row and are always there.
 *
 * They used to appear on hover, which reads as tidier and means the only way to find out that an
 * action can be edited is to happen to point at it.
 */
{
  await evaluate(
    client,
    `(async () => {
       await chrome.storage.local.set({ 'tabterm.actions': [
         { id: 'suite-1', name: 'Suite action', kind: 'command',
           command: 'echo SUITE', where: 'new-tab' } ] });
     })()`,
  );
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === 'Actions')?.click()`,
  );
  await sleep(900);
  const shown = await waitFor(client, `!!document.querySelector('.cmd-row-edit')`, 8000);
  r.ok('an action of your own is listed', shown);

  const visible = JSON.parse(
    await evaluate(
      client,
      `(() => { const e = document.querySelector('.cmd-row-edit');
         const x = document.querySelector('.cmd-row-remove');
         const on = (n) => { if (!n) return null; const s = getComputedStyle(n);
           const b = n.getBoundingClientRect();
           return { shown: s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05,
                    right: Math.round(b.right) }; };
         return JSON.stringify({ edit: on(e), remove: on(x) }); })()`,
    ),
  );
  r.ok(
    'the pencil and the cross are visible without pointing at the row',
    visible.edit?.shown === true && visible.remove?.shown === true,
    JSON.stringify(visible),
  );
  r.ok(
    'and the cross is to the right of the pencil, at the end of the row',
    visible.remove.right > visible.edit.right,
    JSON.stringify(visible),
  );

  await evaluate(
    client,
    `(async () => { await chrome.storage.local.remove('tabterm.actions'); })()`,
  );
}

// Settings.
await evaluate(client, `document.querySelector('.cmd-gear')?.click()`);
await sleep(500);
r.ok(
  'the gear opens settings with a theme choice',
  (await evaluate(client, `!!document.querySelector('.cmd-settings select')`)) === true,
);
/**
 * The keys this page owns, each with a way to change it.
 *
 * Counted from the rows that can be rebound. It used to count the list of fixed keys underneath,
 * which was a list of constants in a panel of settings and has been removed: nothing there could
 * be changed, so it was four lines to read past.
 */
r.ok(
  'and lists the shortcuts the page itself owns, each rebindable',
  Number(await evaluate(client, `document.querySelectorAll('.set-key-row').length`)) > 3,
);

await finish();
r.done();
