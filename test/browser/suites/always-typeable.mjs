// Whatever will receive the next keystroke shows a cursor, at all times.
//
// Reported three times about three different moments, and fixed each time where it was found:
// after a refresh, after placing a marker, after undoing a closed pane. "i need it to be
// consistently present whenever typing is an option somewhere."
//
// So this checks the rule rather than the moments: after each thing that rearranges the page,
// something that draws a cursor holds the keyboard.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  realClick,
  openPaneMenu,
  type,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.pane')");

const holder = async () =>
  JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.keyboardHolder())'));

/** The keyboard is held by something that draws a cursor, given a moment to settle. */
const cursorSomewhere = async (what) => {
  const ok = await waitFor(client, `window.__tabterm.keyboardHolder().typeable === true`, 6000);
  r.ok(`a cursor is showing ${what}`, ok, JSON.stringify(await holder()));
};

await cursorSomewhere('on a tab that has just opened');

/**
 * The start screen is up and typing still goes to the terminal, so the terminal shows a cursor.
 *
 * "the terminal input textbox at the bottom can be typed in without having to click there first,
 * but the typing indicator is just not there."
 */
await sleep(800);
await cursorSomewhere('while the start screen is up');

// And a refresh, which rebuilds the whole page.
await evaluate(client, 'location.reload()');
await sleep(2500);
await waitFor(client, 'window.__tabterm !== undefined');
await waitFor(client, "document.querySelector('.pane')");
await cursorSomewhere('after a refresh');

// Typing dismisses the start screen. Still a cursor.
await type(client, 'echo always-typeable');
await waitFor(client, `document.querySelector('.launcher')?.hidden === true`, 10000);
await cursorSomewhere('once the start screen has gone');

/**
 * A redraw of the start screen does not take the keyboard out of the box being typed into.
 *
 * The start screen follows what the rest of TabTerm is doing, so it redraws whenever a session
 * starts anywhere, and a redraw replaces the path box with a new element. The keyboard is on the
 * old one for an instant, and an instant is enough for "put the keyboard somewhere" to decide the
 * somewhere is the terminal. What is typed next then goes to a shell.
 *
 * In a tab whose start screen is actually up, which is the only state where the box exists to be
 * typed into. The first attempt at this check used a tab that had already been used, where the
 * box is present in the DOM and hidden, and it proved nothing except that focusing a hidden thing
 * does not work.
 */
{
  const fresh = await openTerminal();
  await waitFor(fresh.client, "document.querySelector('.launcher-input')");
  await sleep(800);
  r.ok(
    'a fresh tab has its start screen up, which is what this needs',
    (await evaluate(fresh.client, `document.querySelector('.launcher')?.hidden === false`)) ===
      true,
  );

  await evaluate(fresh.client, `document.querySelector('.launcher-input')?.focus()`);
  await sleep(150);
  const took = String(
    await evaluate(
      fresh.client,
      `document.activeElement?.className || document.activeElement?.tagName`,
    ),
  );
  r.ok('the path box can take the keyboard at all', took.includes('launcher-input'), took);

  for (let i = 0; i < 6; i++) {
    await evaluate(fresh.client, 'window.__tabterm.refreshStartScreen()');
    await sleep(120);
  }
  const after = String(
    await evaluate(
      fresh.client,
      `document.activeElement?.className || document.activeElement?.tagName`,
    ),
  );
  r.ok('and keeps it through a redraw', after.includes('launcher-input'), after);

  for (const ch of '/tmp') {
    await fresh.client.send('Input.dispatchKeyEvent', {
      type: 'char',
      text: ch,
      unmodifiedText: ch,
    });
    await sleep(20);
  }
  await sleep(400);
  r.ok(
    'so what is typed next goes into it',
    String(
      await evaluate(fresh.client, `document.querySelector('.launcher-input')?.value ?? ''`),
    ) === '/tmp',
    String(await evaluate(fresh.client, `document.querySelector('.launcher-input')?.value ?? ''`)),
  );
  r.ok(
    'and none of it reached the shell',
    !String(await evaluate(fresh.client, `window.__tabterm.readScreen() ?? ''`)).includes('/tmp'),
  );
}

/**
 * The keyboard is not taken from a text field somebody is using.
 *
 * The other half of the rule, and the half that makes it safe: nothing draws a cursor that would
 * not receive typing, and nothing takes the keyboard from a box with the cursor in it.
 */
{
  await openPaneMenu(client, 200, 300);
  await realClick(client, '.term-menu-item', 'Name session');
  await waitFor(client, `!!document.querySelector('.pane-label-input')`, 8000);
  await sleep(900);
  const held = await holder();
  r.ok(
    'a form that opens keeps the keyboard, rather than losing it to the terminal',
    held.what.includes('pane-label-input'),
    JSON.stringify(held),
  );
  await evaluate(client, `document.querySelector('.pane-label-form')?.remove()`);
  await sleep(300);
  await cursorSomewhere('after the form goes away');
}

/**
 * Closing a pane, and putting it back.
 *
 * The moment this was reported about. Both halves: the pane goes back where it was, and the
 * keyboard is somewhere that shows it afterwards.
 */
{
  await openPaneMenu(client, 200, 300);
  await realClick(client, '.term-menu-item', 'Split right');
  await waitFor(client, `document.querySelectorAll('.pane').length === 2`, 12000);
  await sleep(600);
  await openPaneMenu(client, 200, 300);
  await realClick(client, '.term-menu-item', 'Split down');
  await waitFor(client, `document.querySelectorAll('.pane').length === 3`, 12000);
  await sleep(800);
  await cursorSomewhere('after splitting');

  const shapeOf = () =>
    evaluate(
      client,
      `(() => {
         const walk = (el) => {
           if (el.classList.contains('pane')) return el.dataset.paneId ?? '?';
           const kids = [...el.children].filter((c) => c.classList.contains('pane') || c.classList.contains('split-node'));
           if (kids.length === 0) return '';
           const dir = el.classList.contains('split-horizontal') ? 'H' : 'V';
           return dir + '(' + kids.map(walk).join(',') + ')';
         };
         const root = document.querySelector('#terminal > .split-node, #terminal > .pane');
         return root ? walk(root) : '';
       })()`,
    );

  const before = String(await shapeOf());
  r.ok('a three pane layout to work with', before.includes(','), before);

  // Close the middle one from its own bar, which is what a person does.
  const victim = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => p.dataset.paneId ?? ''))`,
    ),
  )[1];
  await evaluate(
    client,
    `[...document.querySelectorAll('.pane')].find((p) => p.dataset.paneId === ${JSON.stringify(victim)})
       ?.querySelector('.pane-bar-button.is-close')?.click()`,
  );
  await waitFor(client, `document.querySelectorAll('.pane').length === 2`, 12000);
  await cursorSomewhere('after closing a pane');

  // And back, from the offer that appears.
  const offered = await waitFor(
    client,
    `document.getElementById('undo-offer')?.hidden === false`,
    8000,
  );
  r.ok('closing a pane offers a way back', offered);
  await realClick(client, '#undo-offer-do');
  await waitFor(client, `document.querySelectorAll('.pane').length === 3`, 15000);
  await sleep(1200);

  const after = String(await shapeOf());
  r.ok('undo puts the pane back exactly where it was', after === before, `${before} -> ${after}`);
  await cursorSomewhere('after undoing a closed pane');
}

await finish();
r.done();
