// Right-clicking must never destroy the selection you are right-clicking about.
//
// xterm replaces the selection with the word under the pointer on macOS by default. Over blank
// space that word is empty, so right-clicking past the end of a line silently cleared the
// selection and greyed out Copy in the menu the same click had just opened. Selecting a whole
// line worked, selecting text and right-clicking beside it did not, which from the outside is
// simply "sometimes I can't copy".
import { openTerminal, evaluate, sleep, type, finish } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

await type(client, 'echo "a short line here"');
await sleep(1200);

const box = JSON.parse(
  await evaluate(
    client,
    `(() => {
      const rect = document.querySelector('.pane.focused .xterm-screen').getBoundingClientRect();
      return JSON.stringify({
        l: Math.round(rect.left), t: Math.round(rect.top), r: Math.round(rect.right),
      });
    })()`,
  ),
);

const mouse = (type_, x, y, button = 'left') =>
  client.send('Input.dispatchMouseEvent', {
    type: type_,
    x,
    y,
    button,
    clickCount: 1,
    buttons: button === 'right' ? 2 : 1,
  });

const y = box.t + 30;
const selectLine = async () => {
  await evaluate(client, `document.querySelector('.term-menu')?.remove()`);
  await mouse('mousePressed', box.l + 10, y);
  await mouse('mouseMoved', box.l + 200, y);
  await mouse('mouseReleased', box.l + 200, y);
  await sleep(250);
};

const copyState = async (x) => {
  await mouse('mousePressed', x, y, 'right');
  await mouse('mouseReleased', x, y, 'right');
  await sleep(350);
  return evaluate(
    client,
    `(() => {
      const c = [...document.querySelectorAll('.term-menu-item')].find(b => b.textContent === 'Copy');
      return c ? String(c.disabled) : 'no menu';
    })()`,
  );
};

await selectLine();
r.ok(
  'right-clicking on the selected text keeps Copy available',
  (await copyState(box.l + 100)) === 'false',
);

await selectLine();
r.ok(
  'right-clicking on blank space beside it also keeps Copy available',
  (await copyState(box.r - 30)) === 'false',
  'this is the case that used to grey it out',
);

// And Copy must actually copy what was selected, not nothing.
await evaluate(client, `navigator.clipboard.writeText('BEFORE-COPY')`);
await selectLine();
await copyState(box.r - 30);
await evaluate(
  client,
  `[...document.querySelectorAll('.term-menu-item')].find(b => b.textContent === 'Copy')?.click()`,
);
await sleep(500);
const clip = await evaluate(client, `navigator.clipboard.readText()`);
r.ok(
  'and copies the selected text',
  String(clip).length > 0 && clip !== 'BEFORE-COPY',
  JSON.stringify(String(clip).slice(0, 40)),
);

await finish();
r.done();
