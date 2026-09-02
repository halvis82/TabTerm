// Naming a pane, so four shells in one tab can be told apart.
//
// The name lives on the layout rather than in the page, so it survives a reload and a daemon
// restart the way the split it belongs to does.
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
await evaluate(client, "window.__tabterm.split('horizontal')");
await sleep(3000);
// A fresh pane has the chooser over it, which is what an empty pane is for. Use the pane first,
// the way a person would, so the right click reaches the terminal underneath.
await type(client, 'echo naming-this-pane\r');
await sleep(1500);

const openMenu = () => openPaneMenu(client);
// Found by what it says, not by where it sits. The menu gains entries as the product does, and
// an index was wrong the first time one was added above this.
const nameItem = () =>
  evaluate(
    client,
    `([...document.querySelectorAll('.term-menu-item')].find((b) => /^(Re)?[Nn]ame session/.test(b.textContent ?? ''))?.textContent ?? '')`,
  );

await openMenu();
r.ok(
  'an unnamed session offers a name',
  String(await nameItem()).includes('Name session'),
  String(await nameItem()),
);

// A real press and release, not `.click()`. The menu dismissed itself on mousedown, so every
// entry was dead to a real mouse while this suite passed.
await realClick(client, '.term-menu-item', 'Name session');
await sleep(500);
r.ok('the form opens', await evaluate(client, "!!document.querySelector('.pane-label-form')"));
// The picker is part of the form, not behind a swatch: naming is "type a word and pick a color",
// so both halves are on screen at once.
r.ok(
  'with the color picker already there',
  await evaluate(client, "!!document.querySelector('.pane-label-form .color-picker-map')"),
);
r.ok(
  'showing the color as it stands, above the map',
  await evaluate(client, "!!document.querySelector('.color-picker-current')"),
);
r.ok(
  'and exactly five slots under it',
  Number(await evaluate(client, "document.querySelectorAll('.color-picker-swatch').length")) === 5,
);

await evaluate(client, "document.querySelector('.pane-label-input').value = 'build watch'");
await realClick(client, '.pane-label-color');
await sleep(350);
r.ok(
  'the swatch opens the picker',
  await evaluate(client, "!!document.querySelector('.color-picker-map')"),
);

// Click into the map, which is the whole interaction: there is nothing to type.
const spot = JSON.parse(
  await evaluate(
    client,
    `(() => { const m = document.querySelector('.color-picker-map').getBoundingClientRect();
      return JSON.stringify({ x: m.left + m.width * 0.62, y: m.top + m.height * 0.45 }); })()`,
  ),
);
for (const kind of ['mousePressed', 'mouseReleased']) {
  await client.send('Input.dispatchMouseEvent', {
    type: kind,
    x: spot.x,
    y: spot.y,
    button: 'left',
    clickCount: 1,
  });
}
await sleep(300);
const picked = String(
  await evaluate(client, "document.querySelector('.color-picker-current')?.style.background ?? ''"),
);
r.ok('and picking on the map sets the color, with nothing to confirm', picked !== '', picked);
await realClick(client, '.pane-label-form .term-menu-item', 'Save');
await sleep(1500);

const drawn = JSON.parse(
  await evaluate(
    client,
    "JSON.stringify([...document.querySelectorAll('.pane-label')].map((e) => e.textContent))",
  ),
);
r.ok('the name is drawn on the pane', drawn.includes('build watch'), drawn.join(' | '));

// Drawn the way iTerm draws it: big enough to read across the room, faint enough to read the
// terminal through, and clear of the button in the same corner.
const look = JSON.parse(
  await evaluate(
    client,
    `(() => { const el = document.querySelector('.pane-label');
      const s = getComputedStyle(el); const box = el.getBoundingClientRect();
      const pane = el.closest('.pane').getBoundingClientRect();
      return JSON.stringify({
        size: Math.round(parseFloat(s.fontSize)),
        opacity: parseFloat(s.opacity),
        withinPane: box.right <= pane.right + 1 && box.left >= pane.left - 1,
      }); })()`,
  ),
);
r.ok('at a size you can read at a glance', look.size >= 32, JSON.stringify(look));
r.ok('faint enough to read the terminal through it', look.opacity < 0.3, JSON.stringify(look));
r.ok('and inside the pane it names', look.withinPane, JSON.stringify(look));
const shown = String(
  await evaluate(client, "document.querySelector('.pane-label')?.style.color ?? ''"),
);
r.ok('in the color that was chosen', shown !== '' && shown !== 'rgb(154, 161, 184)', shown);

await openMenu();
r.ok(
  'a named session offers to rename it',
  String(await nameItem()).includes('Rename session'),
  String(await nameItem()),
);
await evaluate(client, "document.querySelector('.term-menu')?.remove()");

// It belongs to the layout, so it comes back with it.
await client.send('Page.reload');
await sleep(6500);
const after = JSON.parse(
  await evaluate(
    client,
    "JSON.stringify([...document.querySelectorAll('.pane-label')].map((e) => e.textContent))",
  ),
);
r.ok('and it survives a reload', after.includes('build watch'), after.join(' | '));

await finish();
r.done();
