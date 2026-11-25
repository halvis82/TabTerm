// A Command click on a link a program redraws under the pointer opens it once.
//
// Asked for by name: "when i hold cmd and press, it still opens twice". Codex underlines the link
// under the pointer by redrawing its row on every mouse move. Each redraw makes the terminal forget
// the link and look for it again, and a click in that gap was told to Codex as well as opening
// here, and Codex opened it too.
import { fileURLToPath } from 'node:url';
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter, listTargets, closeTab } from '../cdp.mjs';

const r = reporter();
const program = fileURLToPath(new URL('../fixtures/link-hover-program.mjs', import.meta.url));
const url = 'https://example.com/tabterm-hovered-link';

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, `node ${program} ${url}\r`);
const screen = () => evaluate(client, `window.__tabterm.readScreen() ?? ''`).then(String);
r.ok(
  'the program shows its link',
  await waitUntil(async () => (await screen()).includes(url), 15000),
);

// Measured once the program is drawing, and the row read off the screen rather than assumed: a
// layout still settling put the pointer a row away from the link, and no click found it.
await sleep(800);
const geo = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())')),
);
const linkRow = (await screen()).split('\n').findIndex((l) => l.includes(url));
r.ok('the link is on a row of its own', linkRow >= 0, `row ${String(linkRow)}`);
const y = Math.round(geo.top + (linkRow + 0.5) * geo.cellHeight);
const at = (col) => Math.round(geo.left + (col + 0.5) * geo.cellWidth);

await client.send('Input.dispatchKeyEvent', {
  type: 'rawKeyDown',
  key: 'Meta',
  code: 'MetaLeft',
  modifiers: 4,
  windowsVirtualKeyCode: 91,
});
let opened = 0;
let told = 0;
for (let attempt = 0; attempt < 5; attempt++) {
  // Moved onto the link and clicked straight away, while the program is still redrawing.
  for (let col = 4 + attempt; col <= 14 + attempt; col++) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: at(col),
      y,
      modifiers: 4,
    });
    await sleep(15);
  }
  for (const kind of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type: kind,
      x: at(14 + attempt),
      y,
      button: 'left',
      clickCount: 1,
      modifiers: 4,
    });
  }
  await sleep(1200);
  const tabs = (await listTargets()).filter((t) => String(t.url).includes('tabterm-hovered-link'));
  opened += tabs.length;
  for (const t of tabs) await closeTab(t.id);
  const m = /CLICKED (\d+)/.exec(await screen());
  told = m ? Number(m[1]) : 0;
}
await client.send('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'Meta',
  code: 'MetaLeft',
  windowsVirtualKeyCode: 91,
});

r.ok('five Command clicks open the link five times here', opened === 5, `${String(opened)} opened`);
r.ok('and the program is told about none of them', told === 0, `${String(told)} told`);

await type(client, 'q', { submit: false });
await finish();
r.done();
