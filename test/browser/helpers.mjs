// Shared driving helpers, so each suite is about what it checks rather than about CDP.
import { closeTab, connect, evaluate, newTab, sleep } from './cdp.mjs';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
export const EXT_ID = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).tabterm
  .extensionId;

/** Open a terminal page and wait for it to attach to a session. */
/**
 * Every terminal a suite opened, so it can end them.
 *
 * Sessions outlive the daemon now, so a suite that walks away leaves shells running on the
 * machine forever. They accumulated into the hundreds before anybody noticed, because nothing
 * in a passing test run says "and twenty processes are still here".
 */
const opened = [];

/** End every session these tests started, and close their tabs. */
export async function finish() {
  for (const { client } of opened) {
    try {
      await evaluate(client, `window.__tabterm?.endSessions?.()`);
    } catch {
      // A tab that already went away has nothing left to clean up.
    }
  }
  await sleep(300);
  // And close the pages. Ending the sessions was not enough: a run of two dozen suites left
  // dozens of live pages open, and the suites that ran last failed on timing that was fine when
  // they ran alone.
  for (const { tab } of opened) await closeTab(tab.id);
  opened.length = 0;
  await sleep(300);
}

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
  opened.push({ client, tab });
  return { client, tab };
}

/**
 * Click the way a hand does: press, then release.
 *
 * `element.click()` dispatches a click directly and never produces the mousedown before it. The
 * pane menu dismissed itself on mousedown, so pressing an entry removed the button before the
 * release, and a click is only dispatched when press and release land on the same element. Every
 * entry was therefore dead to a real mouse, and every test passed, because they all used
 * `.click()`.
 *
 * Anything driven by a pointer is clicked through here now.
 */
export async function realClick(client, selector, text) {
  // An empty answer rather than the string "null": `JSON.parse('null')` is a valid parse that
  // yields null, so a not-found check against a string never fired.
  const answer = String(
    await evaluate(
      client,
      `(() => {
         const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
         // Matched on the element's own first text node as well as its whole text, because a
         // control that carries a badge or a shortcut has more text in it than its label.
         const el = ${
           text === undefined
             ? 'all[0]'
             : `all.find((x) => x.textContent === ${JSON.stringify(text)} || x.firstChild?.textContent === ${JSON.stringify(text)})`
         };
         if (!el) return '';
         const r = el.getBoundingClientRect();
         return JSON.stringify({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
       })()`,
    ),
  );
  if (answer === '') return false;
  const where = JSON.parse(answer);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(where.x),
      y: Math.round(where.y),
      button: 'left',
      clickCount: 1,
    });
  }
  await sleep(250);
  return true;
}

/** Open a pane's context menu with a real right click. */
export async function openPaneMenu(client, x = 80, y = 90) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x, y, button: 'right', clickCount: 1 });
  }
  await sleep(350);
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
// Shift+Command+P. Command+K belongs to the command panel.
export const openPalette = (client) => press(client, 'p', 'KeyP', 12, 80);

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
