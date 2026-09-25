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

await finish();
r.done();
