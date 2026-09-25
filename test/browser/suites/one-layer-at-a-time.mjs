// Only one surface floats over the page at a time, and the top one owns the keyboard.
//
// Reported as a list: an edit dialog drawn over the command menu, Command K toggling that menu
// behind the dialog on every press, a card that Escape would not close, and a half-written
// command that survived changing tab, closing the menu, and reopening it.
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(1200);

const open = async () =>
  JSON.parse(
    String(
      await evaluate(
        client,
        `JSON.stringify({
           panel: Boolean(document.querySelector('.cmd-panel')) && !document.querySelector('.cmd-panel').hidden,
           dialog: Boolean(document.querySelector('.template-backdrop')),
           card: Boolean(document.querySelector('.template-card')),
           // Only counts while the panel is showing: the panel hides rather than closing, so its
           // children are still findable after it has gone.
           form: Boolean(document.querySelector('.cmd-panel:not([hidden]) .cmd-edit')),
           search: Boolean(document.querySelector('.cmd-search')) && !document.querySelector('.cmd-search').hidden,
           tab: document.querySelector('.cmd-tab.on')?.textContent ?? '',
         })`,
      ),
    ),
  );
const press = async (key, code, modifiers = 0) => {
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0),
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0),
  });
  await sleep(350);
};

// The panel, and a command being written in it.
await evaluate(client, `document.querySelector('#cmd-button')?.click()`);
await sleep(600);
r.ok('the panel opens', (await open()).panel);

/*
 * Put on Favorites rather than assumed to be there. The panel remembers its last tab in
 * extension storage, which the whole browser shares, so in a full run it opens wherever another
 * suite left it and the button this needs is not on that tab.
 */
await evaluate(
  client,
  `[...document.querySelectorAll('.cmd-tab')].find((t) => t.textContent === 'Favorites')?.click()`,
);
await waitFor(client, `!!document.querySelector('.cmd-add')`, 6000);
await evaluate(client, `document.querySelector('.cmd-add')?.click()`);
await sleep(500);
const writing = await open();
r.ok('writing a command opens a form', writing.form, JSON.stringify(writing));
r.ok('and the search box goes while it is up', !writing.search, JSON.stringify(writing));

// Leaving the tab leaves the form.
await evaluate(
  client,
  `[...document.querySelectorAll('.cmd-tab')].find((t) => t.textContent === 'Recent')?.click()`,
);
await sleep(500);
r.ok('changing tab closes the form', !(await open()).form, JSON.stringify(await open()));

// It does not come back when the panel is reopened.
await evaluate(
  client,
  `[...document.querySelectorAll('.cmd-tab')].find((t) => t.textContent === 'Favorites')?.click()`,
);
await sleep(300);
await evaluate(client, `document.querySelector('.cmd-add')?.click()`);
await sleep(400);
await evaluate(client, `document.querySelector('#cmd-button')?.click()`);
await sleep(400);
await evaluate(client, `document.querySelector('#cmd-button')?.click()`);
await sleep(600);
r.ok(
  'and closing and reopening the panel does too',
  !(await open()).form,
  JSON.stringify(await open()),
);

/*
 * Escape belongs to the form first and the panel second, which is the order somebody expects:
 * leaving what they are writing should not also throw away the list they were reading.
 */
await evaluate(client, `document.querySelector('.cmd-add')?.click()`);
await sleep(400);
r.ok('a form is up again', (await open()).form);
await press('Escape', 'Escape');
const afterFirst = await open();
r.ok(
  'Escape closes the form and leaves the panel',
  !afterFirst.form && afterFirst.panel,
  JSON.stringify(afterFirst),
);
await press('Escape', 'Escape');
r.ok('and Escape again closes the panel', !(await open()).panel, JSON.stringify(await open()));

/*
 * A card somebody asked for, which is the one that stays.
 *
 * The button beside a template chip pins its card, as against the one that appears because the
 * pointer crossed the chip. A pinned card is a surface with the keyboard's attention, so it takes
 * the page from the menu and Escape puts it away. Escape used to go straight past it to the pane
 * underneath, which for an agent is an interrupt.
 */
await evaluate(client, `document.querySelector('#cmd-button')?.click()`);
await sleep(500);
r.ok('the panel is open again', (await open()).panel);

const hasInfo = await waitFor(client, `!!document.querySelector('.launcher-template-info')`, 8000);
r.ok('there is a template with a card to open', hasInfo);
await evaluate(client, `document.querySelector('.launcher-template-info')?.click()`);
await waitFor(client, `!!document.querySelector('.template-card')`, 6000);
const carded = await open();
r.ok('the card opens', carded.card, JSON.stringify(carded));
r.ok('and takes the page from the menu', !carded.panel, JSON.stringify(carded));

await press('Escape', 'Escape');
r.ok('Escape closes the card', !(await open()).card, JSON.stringify(await open()));

/*
 * A dialog is a question, and the only thing to do with one is answer it.
 *
 * Command K opened the menu behind an open dialog and toggled it on every press: two surfaces,
 * the one on top not the one answering the keyboard.
 */
/*
 * Waited for rather than slept on: on a loaded machine the start screen's own row of layouts is
 * still being built, so the button is not there yet and a fixed wait reports the dialog missing.
 */
const hasAdd = await waitFor(client, `!!document.querySelector('.launcher-add-template')`, 10000);
r.ok('there is a way to open a dialog', hasAdd);
await evaluate(client, `document.querySelector('.launcher-add-template')?.click()`);
await waitFor(client, `!!document.querySelector('.template-backdrop')`, 8000);
r.ok('a dialog opens', (await open()).dialog, JSON.stringify(await open()));
// Command K, which is 4 for Meta in the way the protocol counts modifiers.
await press('k', 'KeyK', 4);
const behind = await open();
r.ok(
  'and Command K does not open the menu behind it',
  !behind.panel && behind.dialog,
  JSON.stringify(behind),
);
/**
 * And a redraw does not take it away.
 *
 * The start screen draws again whenever anything on this machine starts or finishes, which has
 * nothing to do with the person filling in a dialog. This one lived inside the element every
 * render replaces, so it vanished on the next update with everything typed into it and nothing
 * said why. The card beside it had already learned this and lives on the page.
 */
await evaluate(client, `document.querySelector('.template-dialog input')?.focus()`);
await evaluate(
  client,
  `(() => {
     const box = document.querySelector('.template-dialog input');
     if (box) box.value = 'half typed';
   })()`,
);
await evaluate(client, `window.__tabterm.redrawStartScreen()`);
await sleep(400);
const afterRedraw = await open();
r.ok(
  'a redraw of the start screen leaves the dialog alone',
  afterRedraw.dialog,
  JSON.stringify(afterRedraw),
);
r.ok(
  'with what was typed into it',
  String(
    await evaluate(client, `document.querySelector('.template-dialog input')?.value ?? ''`),
  ) === 'half typed',
  String(await evaluate(client, `document.querySelector('.template-dialog input')?.value ?? ''`)),
);

await press('Escape', 'Escape');
await sleep(300);
r.ok('and Escape closes it', !(await open()).dialog, JSON.stringify(await open()));

await finish();
r.done();
