// Command F is ours. Command Shift F is Chrome's, and it has to reach Chrome.
//
// The find bar answered any press with Command and an F in it, without asking about Shift, so
// Command Shift F was caught and prevented as well. Taking a browser shortcut away does not cost
// somebody a key on this page, it costs them that key everywhere they go.
//
// Nothing here wants it: finding backwards is Shift and Return inside the box.
import { openTerminal, evaluate, sleep, finish, waitFor, focusPane } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await focusPane(client);
await sleep(400);

await evaluate(
  client,
  `(() => {
     window.__keys = [];
     window.addEventListener('keydown', (e) => {
       window.__keys.push({
         key: e.key,
         shift: e.shiftKey,
         meta: e.metaKey,
         prevented: e.defaultPrevented,
       });
     });
   })()`,
);

/** A real press of both halves, which is what a shortcut is. */
const press = async (shift) => {
  for (const kind of ['rawKeyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type: kind,
      modifiers: (shift ? 8 : 0) | 4, // Shift and Meta
      key: 'f',
      code: 'KeyF',
      windowsVirtualKeyCode: 70,
      nativeVirtualKeyCode: 3,
    });
  }
  await sleep(500);
};

const barIsOpen = async () =>
  (await evaluate(client, `document.getElementById('find')?.hidden === false`)) === true;

// Command F is ours: it opens the bar.
await press(false);
r.ok('Command F opens the find bar', await barIsOpen());

// Closed again, so the next press is judged from the same starting point.
await press(false);
r.ok('and a second press closes it', (await barIsOpen()) === false);

/*
 * Command Shift F is Chrome's. Ours must neither open nor prevent it: preventing it is what stops
 * the browser acting on it, which is the whole of the report.
 */
await press(true);
r.ok('Command Shift F does not open the find bar', (await barIsOpen()) === false);

const shifted = JSON.parse(
  String(
    await evaluate(
      client,
      `JSON.stringify(window.__keys.filter((k) => k.shift && k.meta && k.key.toLowerCase() === 'f'))`,
    ),
  ),
);
r.ok('and the page saw it', shifted.length > 0, JSON.stringify(shifted));
r.ok(
  'and left it alone for Chrome to act on',
  shifted.every((k) => k.prevented === false),
  JSON.stringify(shifted),
);

await finish();
r.done();
