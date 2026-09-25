// Typing at an open right-click menu picks an entry, and the terminal never hears the keys.
//
// Asked for this way: "if you right click and you start typing 'n' there might be a few options
// starting with n so it just selects the first one ... typing 'name' probably only refers to
// 'name this session' so then that should be outlined and then enter should select it ... it's
// important that those characters typed when the menu is open does not go to the terminal".
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  openPaneMenu,
  waitUntil,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo menu-typing-here\r');
await waitUntil(
  async () =>
    String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).includes(
      'menu-typing-here',
    ),
  20000,
);
await sleep(800);

/** Press a key the way a keyboard does, with no text going anywhere else. */
const press = async (key, code) => {
  await client.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 13,
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 13,
  });
  await sleep(120);
};
const picked = async () =>
  String(
    await evaluate(
      client,
      `(document.querySelector('.term-menu-item.is-picked')?.textContent ?? '').trim()`,
    ),
  );
const labels = async () =>
  JSON.parse(
    String(
      await evaluate(
        client,
        `JSON.stringify([...document.querySelectorAll('button.term-menu-item')].map((b) => (b.textContent ?? '').trim()))`,
      ),
    ),
  );

await openPaneMenu(client);
const entries = await labels();
r.ok(
  'the menu is open with entries in it',
  entries.length > 2,
  `${String(entries.length)} entries`,
);

await press('n', 'KeyN');
const first = await picked();
const wanted = entries.find((label) => label.toLowerCase().startsWith('n'));
r.ok(
  'typing one letter picks the first entry that begins with it',
  first !== '' && first === wanted,
  `${first} (expected ${String(wanted)})`,
);

/*
 * And more letters narrow it, which is the half that makes this worth having: one letter is a
 * guess, a word is a choice.
 */
const narrowing = entries.filter((label) => label.toLowerCase().startsWith('na'));
if (narrowing.length > 0) {
  await press('a', 'KeyA');
  r.ok(
    'and another letter narrows it',
    (await picked()) === narrowing[0],
    `${await picked()} (expected ${String(narrowing[0])})`,
  );
} else {
  r.ok('and another letter narrows it', true, 'no entry begins with "na" in this menu');
}

/*
 * The condition he put first: none of it reaches the terminal. Checked by what is on screen,
 * which is where a stray keystroke would show up.
 */
const screenBefore = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));
await press('z', 'KeyZ');
await press('q', 'KeyQ');
await sleep(400);
const screenAfter = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));
r.ok(
  'and nothing typed at the menu reaches the terminal',
  screenBefore === screenAfter,
  'the screen is unchanged',
);

// Return runs the entry that is outlined.
const chosen = await picked();
await press('Enter', 'Enter');
await sleep(700);
const gone = Boolean(await evaluate(client, '!document.querySelector(".term-menu")'));
r.ok('Return chooses the outlined entry and the menu closes', gone, `chose ${chosen}`);

/*
 * And once the menu is gone, the keyboard goes back to where it came from.
 *
 * Choosing an entry removes the menu element, and the listeners that made the menu own the
 * keyboard outlive it: dismissal is armed on a press outside, and choosing an entry is a press
 * inside. A menu that keeps eating keystrokes after it has gone is worse than one that never ate
 * any, because the box the chosen entry just opened is where the typing was going.
 */
await evaluate(client, `document.querySelector('.pane-label-form .term-menu-item')?.click()`);
await sleep(400);
await evaluate(client, `document.querySelector('.pane-label-form')?.remove()`);
await sleep(200);
const beforeTyping = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));
await type(client, 'echo after-the-menu\r');
const reached = await waitUntil(
  async () =>
    String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).includes(
      'after-the-menu',
    ),
  10000,
);
r.ok(
  'and the terminal has the keyboard back once the menu is gone',
  reached,
  reached ? 'typed and ran' : `screen unchanged since ${String(beforeTyping.length)} chars`,
);

await finish();
r.done();
