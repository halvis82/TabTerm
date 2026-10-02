// Native macOS Option text must reach a raw-mode program without an Escape prefix.
import { openTerminal, evaluate, type, press, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
import { fileURLToPath } from 'node:url';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
const listener = fileURLToPath(new URL('../fixtures/key-listener.mjs', import.meta.url));
await type(client, `node ${listener}\r`);
await waitFor(client, 'window.__tabterm?.readScreen().includes("SAW:")');
const report = () => evaluate(client, 'window.__tabterm.readScreen().split("SAW:").pop().trim()');

async function character(key, code, keyCode, modifiers = 1) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: keyCode,
    text: key,
    unmodifiedText: key,
  });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
}

await character('∞', 'Digit5', 53);
await waitFor(client, 'window.__tabterm.readScreen().includes("e2,88,9e")');
let received = String(await report());
r.ok(
  'Option 5 sends UTF-8 infinity without Meta prefix',
  received.endsWith('e2,88,9e') && !received.includes('1b,e2'),
  received,
);
await character('Å', 'KeyA', 65, 9);
await waitFor(client, 'window.__tabterm.readScreen().includes("c3,85")');
received = String(await report());
r.ok('Option Shift character arrives once', received.endsWith('e2,88,9e,c3,85'), received);

// A dead key must remain uncanceled so the OS can compose the next character.
const dead = await evaluate(
  client,
  `(() => {
  const e = new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyE', altKey: true, bubbles: true, cancelable: true });
  document.activeElement.dispatchEvent(e);
  return e.defaultPrevented;
})()`,
);
r.ok('Option dead key is left to native composition', dead === false, String(dead));
await character('é', 'KeyE', 69, 0);
await waitFor(client, 'window.__tabterm.readScreen().includes("c3,a9")');
received = String(await report());
r.ok(
  'composed accent reaches the program once',
  received.endsWith('e2,88,9e,c3,85,c3,a9'),
  received,
);

await press(client, 'Enter', 'Enter', 1, 13);
await press(client, 'ArrowLeft', 'ArrowLeft', 1, 37);
await press(client, 'Backspace', 'Backspace', 1, 8);
await waitFor(client, 'window.__tabterm.readScreen().includes("1b,7f")');
received = String(await report());
r.ok('Option Return retains Escape CR', received.includes('c3,a9,1b,0d'), received);
r.ok('Option Left retains word navigation', received.includes('1b,5b,31,3b,33,44'), received);
r.ok('Option Backspace retains word deletion', received.endsWith('1b,7f'), received);
await finish();
r.done();
