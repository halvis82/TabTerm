// A right click anywhere in TabTerm opens a TabTerm menu, and what it offers fits where it landed.
//
// Asked for directly: "i want right click anywhere in tabterm to just be tabterm related stuff,
// not the chrome right click... just choose logically for every possible place to right click".
// Chrome's menu knows nothing about a terminal drawn on a canvas: it offers Reload, Save As and
// an offer to translate the page.
import { openTerminal, evaluate, sleep, finish, waitFor, openPaneMenu } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(1500);

const menuAt = async (selector) => {
  const at = JSON.parse(
    await evaluate(
      client,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return 'null';
         const b = el.getBoundingClientRect();
         return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }); })()`,
    ),
  );
  if (at === null) return null;
  await openPaneMenu(client, at.x, at.y);
  const labels = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map((b) => (b.textContent ?? '').trim()))`,
    ),
  );
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");
  return labels;
};

// The start screen: paste, and the ways out. No markers, which act on a screen of output.
const onLauncher = await menuAt('.launcher-heading');
r.ok(
  'a right click on the start screen opens a menu',
  (onLauncher ?? []).length > 0,
  JSON.stringify(onLauncher),
);
r.ok(
  'it offers paste and the ways out',
  ['Paste', 'New terminal tab', 'Open menu', 'Settings', 'Close tab'].every((l) =>
    (onLauncher ?? []).includes(l),
  ),
  JSON.stringify(onLauncher),
);
r.ok(
  'and nothing that acts on a screen of output',
  !(onLauncher ?? []).some((l) => /marker|highlight|Select all|Kill session/i.test(l)),
  JSON.stringify(onLauncher),
);

// A box for typing into gets what a box for typing into should have.
const onBox = await menuAt('.launcher-input');
r.ok(
  'a text box offers the clipboard entries, acting on that box',
  ['Cut', 'Copy', 'Paste', 'Select all'].every((l) => (onBox ?? []).includes(l)),
  JSON.stringify(onBox),
);

// The command menu offers a way to put it away rather than a way to open it.
await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await sleep(700);
const onPanel = await menuAt('.cmd-panel');
r.ok(
  'the command menu offers settings and a way to close itself',
  (onPanel ?? []).includes('Settings') && (onPanel ?? []).includes('Close menu'),
  JSON.stringify(onPanel),
);
r.ok(
  'and does not offer to open the menu that is already open',
  !(onPanel ?? []).includes('Open menu'),
  JSON.stringify(onPanel),
);
await evaluate(client, `document.querySelector('.cmd-header .cmd-icon')?.click()`);
await sleep(500);

// And the terminal keeps its own, which is much richer.
const onTerminal = (await menuAt('.xterm-screen')) ?? [];
r.ok(
  'a terminal keeps its own menu, which the page one never replaces',
  onTerminal.some((l) => l.includes('Add a marker')) && onTerminal.some((l) => l.includes('Paste')),
  onTerminal.join(' | ').slice(0, 140),
);
await finish();
r.done();
