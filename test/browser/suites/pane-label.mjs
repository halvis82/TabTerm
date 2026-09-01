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
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await sleep(4500);
await evaluate(client, "window.__tabterm.split('horizontal')");
await sleep(3000);
// A fresh pane has the chooser over it, which is what an empty pane is for. Use the pane first,
// the way a person would, so the right click reaches the terminal underneath.
await type(client, 'echo naming-this-pane\r');
await sleep(1500);

const openMenu = () => openPaneMenu(client);
const firstItem = () =>
  evaluate(client, "document.querySelectorAll('.term-menu-item')[4]?.textContent ?? ''");

await openMenu();
r.ok(
  'an unnamed session offers a name',
  String(await firstItem()).includes('Name session'),
  String(await firstItem()),
);

// A real press and release, not `.click()`. The menu dismissed itself on mousedown, so every
// entry was dead to a real mouse while this suite passed.
await realClick(client, '.term-menu-item', 'Name session');
await sleep(500);
r.ok('the form opens', await evaluate(client, "!!document.querySelector('.pane-label-form')"));
r.ok(
  'with a color to pick',
  Number(await evaluate(client, "document.querySelectorAll('.pane-label-color').length")) > 1,
);

await evaluate(client, "document.querySelector('.pane-label-input').value = 'build watch'");
await realClick(client, '.pane-label-color:nth-of-type(2)');
await realClick(client, '.pane-label-form .term-menu-item', 'Save');
await sleep(1500);

const drawn = JSON.parse(
  await evaluate(
    client,
    "JSON.stringify([...document.querySelectorAll('.pane-label')].map((e) => e.textContent))",
  ),
);
r.ok('the name is drawn on the pane', drawn.includes('build watch'), drawn.join(' | '));
r.ok(
  'in the color that was chosen',
  String(
    await evaluate(client, "document.querySelector('.pane-label')?.style.color ?? ''"),
  ).includes('122'),
);

await openMenu();
r.ok(
  'a named session offers to rename it',
  String(await firstItem()).includes('Rename session'),
  String(await firstItem()),
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
