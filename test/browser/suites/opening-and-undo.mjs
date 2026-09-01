// What the screen says after opening a folder, and after taking a clear back.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  realClick,
  openPaneMenu,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await sleep(5000);

const lines = async () =>
  (await evaluate(client, 'window.__tabterm.readScreen()'))
    .split(String.fromCharCode(10))
    .filter((l) => l.trim() !== '');

// The start screen is open. Type a path and press Return, which is how anybody opens a folder.
await evaluate(
  client,
  `(() => { const i = document.querySelector('.launcher-input'); i.focus();
    i.value = '~/Documents'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
);
await sleep(400);
await client.send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
});
await client.send('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
});
await sleep(2200);

const opened = await lines();
const cds = opened.filter((l) => l.includes('cd ~/Documents') || l.includes("cd ~/'Documents"));
r.ok('opening a folder runs cd once, not twice', cds.length === 1, JSON.stringify(opened));
r.ok(
  'and does not quote a path that needs no quoting',
  !opened.join(' ').includes("~/'Documents'"),
  JSON.stringify(cds),
);
r.ok('it actually moved', (await lines()).join(' ').includes('Documents'));

// Now clear, then take it back.
await type(client, 'echo before-the-clear\r');
await sleep(1400);
const was = await lines();
await openPaneMenu(client, 60, 60);
await realClick(client, '.term-menu-item', 'Clear');
await sleep(1500);
r.ok('the clear emptied it', !(await lines()).join(' ').includes('before-the-clear'));

await realClick(client, '#clear-undo');
await sleep(1200);
const restored = await lines();
r.ok('undo brings the output back', restored.join(' ').includes('before-the-clear'));

/**
 * The defect: the restored screen was written **after** the prompt the shell had just redrawn,
 * so the first line carried two prompts and a copy of the prompt was left above everything.
 *
 * Asserted as "the screen is what it was", which is what undo means, rather than by counting
 * prompts. Counting them measured the harness as much as the product: `type` sends its own
 * Return on top of the one in the string, so every suite's screen carries an extra prompt line
 * that has nothing to do with clearing.
 */
r.ok(
  'and puts the screen back exactly as it was',
  JSON.stringify(restored) === JSON.stringify(was),
  JSON.stringify({ was, restored }),
);
const doubled = restored.filter((l) => l.split('%').length > 2 && l.includes('@'));
r.ok('with no line carrying two prompts', doubled.length === 0, JSON.stringify(doubled));

await finish();
r.done();
