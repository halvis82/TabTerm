// Shared driving helpers, so each suite is about what it checks rather than about CDP.
import { connect, evaluate, newTab, sleep } from './cdp.mjs';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
export const EXT_ID = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).tabterm
  .extensionId;

/** Open a terminal page and wait for it to attach to a session. */
export async function openTerminal(query = '') {
  const tab = await newTab(`chrome-extension://${EXT_ID}/terminal.html${query}`);
  const client = connect(tab.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  // Input events go to the active target. With several tabs open in one headless browser, a
  // newly opened one is not automatically it, and every keystroke is silently discarded --
  // the page looks perfectly healthy and simply never receives anything.
  await client.send('Page.bringToFront');
  await sleep(4000);
  return { client, tab };
}

export const focusPane = (client) =>
  evaluate(client, `document.querySelector('.pane.focused .xterm-helper-textarea')?.focus()`);

/** Type text and submit it, the way a person does. */
export async function type(client, text, { submit = true } = {}) {
  await focusPane(client);
  for (const ch of text) {
    await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
    await sleep(4);
  }
  if (submit) {
    await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r' });
  }
}

/**
 * Press a key with modifiers.
 *
 * `rawKeyDown`, not `char`. A `char` event is not a keydown, so xterm never turns it into a
 * control sequence: Ctrl+C sent as a char does nothing at all. That mistake cost time three
 * separate times before it was written down here.
 *
 * modifiers: 1 alt, 2 ctrl, 4 meta, 8 shift.
 */
export async function press(
  client,
  key,
  code,
  modifiers = 0,
  keyCode = 0,
  { focus = 'pane' } = {},
) {
  // Focus decides where the key lands. Terminal keys need the pane; palette keys must not steal
  // focus away from the palette input, or they are delivered to the shell instead and the
  // palette looks unresponsive.
  if (focus === 'pane') await focusPane(client);
  for (const type_ of ['rawKeyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type: type_,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }
}

/** Ctrl+C, which needs a real keydown to become an interrupt. */
export const interrupt = (client) => press(client, 'c', 'KeyC', 2, 67);

/** Open the command palette. */
export const openPalette = (client) => press(client, 'k', 'KeyK', 4, 75);

/** A key aimed at the palette, which owns focus while it is open. */
export const pressInPalette = (client, key, code, modifiers = 0, keyCode = 0) =>
  press(client, key, code, modifiers, keyCode, { focus: 'none' });

/** Read the terminal buffer, which WebGL rendering puts out of the DOM's reach. */
export const readScreen = (client, paneId) =>
  evaluate(client, `window.__tabterm?.readScreen(${paneId ? JSON.stringify(paneId) : ''}) ?? ''`);

export const paneCount = (client) => evaluate(client, `document.querySelectorAll('.pane').length`);

/** Query the launcher, which is where most contributed UI shows up. */
export const launcherSections = (client) =>
  evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.launcher-heading')].map(h => h.textContent))`,
  ).then((s) => JSON.parse(s ?? '[]'));

export async function launcherSection(client, heading) {
  const raw = await evaluate(
    client,
    `(() => {
      const wrap = [...document.querySelectorAll('.launcher-section')].find(
        s => (s.querySelector('.launcher-heading')?.textContent ?? '').includes(${JSON.stringify(heading)}));
      return JSON.stringify(wrap ? { found: true, text: wrap.textContent } : { found: false });
    })()`,
  );
  return JSON.parse(raw ?? '{"found":false}');
}

export { sleep, evaluate, newTab, connect };
