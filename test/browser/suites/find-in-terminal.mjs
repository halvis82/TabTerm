// Finding text in a terminal, which the browser cannot do for us.
//
// Chrome's find reads the page. The terminal is a canvas drawn by WebGL, so the browser's bar opens
// and matches nothing, and drawing with elements would not help: xterm renders the rows in view and
// the scrollback is the part worth searching. So the search asks the emulator, and this checks that
// it reaches the scrollback rather than only what is on screen.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

const TAG = `find-${String(Date.now()).slice(-6)}`;

// Printed first, then buried under enough output to push it off the screen.
await type(client, `printf '${TAG}-needle\\n'`);
await sleep(400);
await type(client, `for i in $(seq 1 120); do echo filler-$i; done`);
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('filler-120')`, 20000);
await sleep(400);

// Gone from the visible screen, which is what makes this worth checking.
const onScreen = String(await evaluate(client, 'window.__tabterm.readViewport() ?? ""'));
r.ok('the text has scrolled out of view', !onScreen.includes(`${TAG}-needle`));

const findBar = async (js) => String(await evaluate(client, js));

// Command+F, as a person presses it.
await evaluate(
  client,
  `document.querySelector('.xterm-helper-textarea')?.dispatchEvent(new KeyboardEvent('keydown', {
     key: 'f', metaKey: true, bubbles: true, cancelable: true
   }))`,
);
await sleep(300);
r.ok(
  'the find bar opens',
  (await findBar('document.getElementById("find")?.hidden === false')) === 'true',
);

await evaluate(
  client,
  `(() => {
     const i = document.getElementById('find-input');
     i.value = ${JSON.stringify(`${TAG}-needle`)};
     i.dispatchEvent(new Event('input'));
   })()`,
);
await sleep(600);

const count = await findBar('document.getElementById("find-count")?.textContent ?? ""');
r.ok('it finds text that is only in the scrollback', count !== 'no matches' && count !== '', count);

// And the terminal scrolled to it, which is the whole point of finding something.
const after = String(await evaluate(client, 'window.__tabterm.readViewport() ?? ""'));
r.ok('and scrolls the match into view', after.includes(`${TAG}-needle`));

await evaluate(
  client,
  `document.getElementById('find-input')?.dispatchEvent(new KeyboardEvent('keydown', {
     key: 'Escape', bubbles: true, cancelable: true
   }))`,
);
await sleep(200);
r.ok(
  'Escape closes it',
  (await findBar('document.getElementById("find")?.hidden === true')) === 'true',
);

/**
 * A second Command F closes ours rather than handing the key to Chrome.
 *
 * It used to be answered inside the terminal's own key handler, which only runs while the terminal
 * has the keyboard. Opening the bar moves the keyboard into its box, so the next press reached
 * nothing of ours and Chrome opened its own find, which cannot see a canvas and would only ever
 * have searched the rows in view.
 *
 * Pressed with a real key event at the window, and from inside the bar's own box, which is where
 * the keyboard actually is when somebody presses it a second time.
 */
{
  const press = (selector) =>
    evaluate(
      client,
      `(() => {
         const el = ${selector};
         const e = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
         (el ?? window).dispatchEvent(e);
         return e.defaultPrevented;
       })()`,
    );

  const openedAgain = String(await press("document.querySelector('.xterm-helper-textarea')"));
  await sleep(250);
  r.ok('opening it again from the terminal is taken by us', openedAgain === 'true');
  r.ok(
    'and it is open',
    (await findBar('document.getElementById("find")?.hidden === false')) === 'true',
  );

  const fromTheBox = String(await press("document.getElementById('find-input')"));
  await sleep(250);
  r.ok('a press from inside the box is taken by us too', fromTheBox === 'true');
  r.ok(
    'and closes it rather than opening a second one',
    (await findBar('document.getElementById("find")?.hidden === true')) === 'true',
  );
}

await finish();
r.done();
