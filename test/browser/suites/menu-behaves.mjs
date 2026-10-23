// The command menu, the way it was reported on 2026-10-23.
//
// One highlight shared by the pointer and the arrow keys. A press anywhere on the menu gives it
// the keyboard back from the terminal. Deleting an action you made asks first. The built-in
// actions are listed by kind. A greyed marker says what is in the way. And the menu button lines
// up under the close cross of a split tab.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo MENU-BEHAVES\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('MENU-BEHAVES')`, 20000);

const openPanel = async () => {
  const hidden = await evaluate(client, `String(document.querySelector('.cmd-panel')?.hidden)`);
  if (String(hidden) !== 'false') {
    await evaluate(client, `document.getElementById('cmd-button')?.click()`);
  }
  return waitFor(client, `document.querySelector('.cmd-panel')?.hidden === false`, 8000);
};
const toTab = (name) =>
  evaluate(
    client,
    `[...document.querySelectorAll('.cmd-tab')].find(t => t.textContent === ${JSON.stringify(name)})?.click()`,
  );
const centerOf = async (selector) =>
  JSON.parse(
    String(
      await evaluate(
        client,
        `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
           return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 }); })()`,
      ),
    ),
  );
const mouse = (type_, x, y, extra = {}) =>
  client.send('Input.dispatchMouseEvent', { type: type_, x, y, button: 'none', ...extra });
const key = async (k, code, keyCode, modifiers = 0) => {
  for (const type_ of ['rawKeyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type: type_,
      key: k,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }
  await sleep(150);
};
const selectedLabel = () =>
  evaluate(
    client,
    `[...document.querySelectorAll('.cmd-row.selected .cmd-row-label')].map(e => e.textContent).join('|')`,
  );

// An action of our own, so there is something to delete.
await evaluate(
  client,
  `(async () => {
     await chrome.storage.local.set({ 'tabterm.actions': [
       { id: 'menu-1', name: 'Menu suite action', kind: 'command',
         command: 'echo MENU', where: 'new-tab' } ] });
   })()`,
);
await openPanel();
await toTab('Actions');
await waitFor(client, `!!document.querySelector('.cmd-row-remove')`, 8000);

/*
 * The built-ins are grouped by kind: the two splits are next to each other.
 */
const order = JSON.parse(
  String(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.cmd-row.is-action .cmd-row-label')].map(e => e.textContent))`,
    ),
  ),
);
const right = order.indexOf('Split right');
r.ok(
  'Split down comes straight after Split right',
  order[right + 1] === 'Split down',
  order.join(', '),
);
r.ok(
  'and naming and marking are together, after the tabs and agents',
  order.indexOf('Add a marker here') === order.findIndex((t) => /ame session/.test(t)) + 1 &&
    order.indexOf('Add a marker here') > order.indexOf('New terminal tab'),
  order.join(', '),
);

/*
 * One highlight. Moving the pointer onto a row selects it, the arrows carry on from there, and
 * nothing else is lit.
 */
const firstRow = JSON.parse(
  String(
    await evaluate(
      client,
      `(() => { const b = document.querySelectorAll('.cmd-row.is-action')[2].getBoundingClientRect();
         return JSON.stringify({ x: b.left + 40, y: b.top + b.height / 2 }); })()`,
    ),
  ),
);
await mouse('mouseMoved', firstRow.x, firstRow.y);
await sleep(150);
const hovered = await selectedLabel();
r.ok(
  'a pointer that moves onto a row selects it',
  hovered !== '' && !hovered.includes('|'),
  hovered,
);
await key('ArrowDown', 'ArrowDown', 40);
const afterArrow = await selectedLabel();
const lit = Number(
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-row')].filter(r => { const s = getComputedStyle(r);
       return r.classList.contains('selected') || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent'); }).length`,
  ),
);
r.ok(
  'the arrow carries on from the hovered row',
  afterArrow !== hovered && afterArrow !== '',
  `${hovered} -> ${afterArrow}`,
);
r.ok('and only one row is lit, though the pointer is still over another', lit === 1, String(lit));
// The list scrolling under a still pointer is not the pointer moving.
await mouse('mouseMoved', firstRow.x, firstRow.y);
await sleep(150);
r.ok('a pointer that has not moved changes nothing', (await selectedLabel()) === afterArrow);

/*
 * Deleting an action you made asks first.
 */
await evaluate(client, `document.querySelector('.cmd-row-remove').click()`);
await sleep(300);
const asked = String(
  await evaluate(client, `document.querySelector('.cmd-ask-text')?.textContent ?? ''`),
);
const stillThere = await evaluate(client, `!!document.querySelector('.cmd-row-remove')`);
r.ok('the cross asks before deleting an action', asked.includes('Menu suite action'), asked);
r.ok('and nothing is deleted until the answer', stillThere === true);
await key('Escape', 'Escape', 27);
await sleep(300);
r.ok(
  'Escape takes the question back and keeps the action',
  (await evaluate(
    client,
    `!!document.querySelector('.cmd-row-remove') && !document.querySelector('.cmd-ask')`,
  )) === true,
);

/*
 * A press on the menu takes the keyboard back from the terminal.
 */
// A point on the terminal that the menu does not cover: the menu sits over the middle of it.
const pane = JSON.parse(
  String(
    await evaluate(
      client,
      `(() => { const p = document.querySelector('.pane-terminal').getBoundingClientRect();
         const m = document.querySelector('.cmd-panel').getBoundingClientRect();
         for (const [x, y] of [[p.left + 20, p.bottom - 20], [p.left + 20, p.top + 20], [p.right - 20, p.bottom - 20]]) {
           if (x < m.left || x > m.right || y < m.top || y > m.bottom) return JSON.stringify({ x, y });
         }
         return JSON.stringify({ x: p.left + 5, y: p.bottom - 5 }); })()`,
    ),
  ),
);
await client.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: pane.x,
  y: pane.y,
  button: 'left',
  clickCount: 1,
});
await client.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: pane.x,
  y: pane.y,
  button: 'left',
  clickCount: 1,
});
await sleep(400);
const inTerminal = await evaluate(
  client,
  `!document.querySelector('.cmd-panel').contains(document.activeElement)`,
);
r.ok('clicking the terminal hands it the keyboard', inTerminal === true);
r.ok(
  'and the terminal is listening again',
  (await evaluate(
    client,
    `document.getElementById('terminal').classList.contains('panel-has-keyboard')`,
  )) === false,
);
const header = await centerOf('.cmd-header');
// The empty end of the header, away from the tab buttons.
const headerBox = JSON.parse(
  String(
    await evaluate(
      client,
      `JSON.stringify(document.querySelector('.cmd-header').getBoundingClientRect())`,
    ),
  ),
);
const emptyX = headerBox.right - 60;
await client.send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: emptyX,
  y: header.y,
  button: 'left',
  clickCount: 1,
});
await client.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: emptyX,
  y: header.y,
  button: 'left',
  clickCount: 1,
});
await sleep(400);
const back = String(await evaluate(client, `document.activeElement?.className ?? ''`));
r.ok('a press on the empty top bar gives the menu the keyboard', back.includes('cmd-search'), back);
r.ok(
  'and the terminal says it is not listening',
  (await evaluate(
    client,
    `document.getElementById('terminal').classList.contains('panel-has-keyboard')`,
  )) === true,
);
const tabBefore = String(
  await evaluate(client, `document.querySelector('.cmd-tab.on')?.textContent`),
);
await key('Tab', 'Tab', 9);
const tabAfter = String(
  await evaluate(client, `document.querySelector('.cmd-tab.on, .cmd-gear.on')?.textContent`),
);
r.ok('so Tab moves the menu, not the shell', tabAfter !== tabBefore, `${tabBefore} -> ${tabAfter}`);
await key('Escape', 'Escape', 27);

/*
 * A greyed marker says what is in the way, in an agent session.
 */
const port = Number(process.env['TT_DAEMON_PORT'] ?? '7377') + 1;
const token = process.env['TT_DAEMON_TOKEN'] ?? '';
const sessionId = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')),
)[0].sessionId;
await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
  method: 'POST',
  headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId, hook: 'SessionStart' }),
});
await sleep(600);
await openPanel();
await toTab('Actions');
await sleep(400);
const why = String(
  await evaluate(
    client,
    `[...document.querySelectorAll('.cmd-row')].find(r => r.textContent.includes('Add a marker here'))?.querySelector('.cmd-row-meta')?.textContent ?? ''`,
  ),
);
r.ok('in an agent session the marker says the agent is in the way', /agent/i.test(why), why);
await key('Escape', 'Escape', 27);

/*
 * The menu button lines up under the close cross of a split tab.
 */
await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1200);
const fit = JSON.parse(
  String(
    await evaluate(
      client,
      `(() => { const box = (el) => el.getBoundingClientRect();
         const close = [...document.querySelectorAll('.pane-bar-button.is-close')].map(box).sort((a, b) => b.right - a.right)[0];
         const bar = [...document.querySelectorAll('.pane-bar')].map(box).sort((a, b) => b.right - a.right)[0];
         const cmd = box(document.getElementById('cmd-button'));
         return JSON.stringify({ off: Math.abs((close.left + close.right) / 2 - (cmd.left + cmd.right) / 2),
                                 gap: cmd.top - bar.bottom }); })()`,
    ),
  ),
);
r.ok('the menu button is centered under the close cross', fit.off <= 1, JSON.stringify(fit));
r.ok('and sits clear of the bar', fit.gap >= 2, JSON.stringify(fit));

await finish();
r.done();
