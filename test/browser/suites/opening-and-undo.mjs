// What the screen says after opening a folder, and after taking a clear back.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  realClick,
  openPaneMenu,
  waitFor,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(client, "document.querySelector('.launcher-input')");

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
/**
 * Printed in color on purpose.
 *
 * Undo used to bring back the text and nothing else: an hour of build output came back in a
 * uniform gray, every error that had been red and every path that had been blue flattened. The
 * escape sequence here is the plainest possible one, red then back to default, so the check is
 * about whether attributes survive rather than about any particular palette.
 */
const RED = 'before-the-clear';
await type(client, `printf '\\033[31m${RED}\\033[0m\\n'\r`);
await sleep(1400);
const was = await lines();
const colorOf = async (needle) =>
  JSON.parse(
    await evaluate(
      client,
      `(() => {
         // From the bottom. The line the shell echoed carries the text as well, because it is
         // part of the command that printed it, and that line is not colored.
         for (let y = 59; y >= 0; y--) {
           const runs = window.__tabterm.lineColors(y);
           const hit = runs.find((run) => run.text.includes(${JSON.stringify(needle)}));
           if (hit) return JSON.stringify(hit.fg);
         }
         return JSON.stringify(null);
       })()`,
    ),
  );
const wasColored = await colorOf(RED);
r.ok(
  'the text was printed in a color to begin with',
  wasColored !== null && wasColored !== -1,
  String(wasColored),
);
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
r.ok(
  'and brings the colors back with it, not only the text',
  (await colorOf(RED)) === wasColored,
  `was ${String(wasColored)}, now ${String(await colorOf(RED))}`,
);
const doubled = restored.filter((l) => l.split('%').length > 2 && l.includes('@'));
r.ok('with no line carrying two prompts', doubled.length === 0, JSON.stringify(doubled));

/**
 * A refresh leaves the strip looking the way it did.
 *
 * It did not: the whole screen arrives at once after a reload, and the scroll that keeps the
 * prompt at the bottom was issued in the same turn as the write, so it scrolled to the bottom of
 * what was there a moment earlier and left the box apparently empty.
 */
const promptLine = `(() => {
  const s = window.__tabterm.readScreen() ?? '';
  const lines = s.split(String.fromCharCode(10)).filter((l) => l.trim() !== '');
  return lines[lines.length - 1] ?? '';
})()`;
const beforeRefresh = String(await evaluate(client, promptLine));
r.ok('there is a prompt to lose', beforeRefresh.trim() !== '', beforeRefresh);

await evaluate(client, 'location.reload()');
await sleep(6000);
await waitFor(client, 'Boolean(window.__tabterm)', 20000);
await sleep(2500);
const afterRefresh = String(await evaluate(client, promptLine));
r.ok(
  'and it is still there after a refresh',
  afterRefresh.trim() !== '',
  `before ${JSON.stringify(beforeRefresh.slice(-30))}, after ${JSON.stringify(afterRefresh.slice(-30))}`,
);

await finish();
r.done();
