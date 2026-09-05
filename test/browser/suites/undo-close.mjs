// Closing a pane, and moving one to its own tab, can both be taken back.
//
// Both were final. Closing a pane ended its shell on the spot, so a misplaced click destroyed
// whatever was in it, and a gesture with no way back is one people learn to be careful with.
// The daemon holds a closed pane's terminal for five minutes instead, which is what makes an
// undo possible at all: the same terminal comes back, not a new one in the same folder.
import { openTerminal, evaluate, sleep, finish, type, waitFor, realClick } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo FIRST-PANE\r');
await sleep(1500);

await evaluate(client, "window.__tabterm.split('horizontal')");
await sleep(3500);
const panes = () => evaluate(client, 'window.__tabterm.paneIds().length').then((n) => Number(n));
r.ok('two panes to work with', (await panes()) === 2, String(await panes()));

// A marker in the second pane, which is what proves the same terminal came back rather than a
// new one opened in the same folder.
// From `paneIds`, not from `transport`, whose ids are shortened for reading.
const second = String(await evaluate(client, 'window.__tabterm.paneIds()[1] ?? ""'));
await evaluate(client, `window.__tabterm.focus(${JSON.stringify(second)})`);
await sleep(400);
await type(client, 'echo SECOND-PANE-MARKER\r');
await waitFor(
  client,
  `(window.__tabterm.readScreen(${JSON.stringify(second)}) ?? '').includes('SECOND-PANE-MARKER')`,
  20000,
);

await evaluate(client, 'window.__tabterm.closePane()');
// Waited for rather than slept through: closing is a round trip to the daemon and back, and two
// seconds is an idle machine's answer to a question about a busy one.
const closed = await waitFor(client, 'window.__tabterm.paneIds().length === 1', 30000);
r.ok('closing takes the pane away', closed, String(await panes()));

const offered = await waitFor(client, `!document.getElementById('undo-offer')?.hidden`, 30000);
r.ok(
  'and a way back appears under the menu button',
  offered,
  String(await evaluate(client, `document.getElementById('undo-offer-do')?.textContent ?? ''`)),
);

/**
 * The cross hides the button and keeps the key.
 *
 * Asked for that way, and it is the right split: hiding a reminder is not the same as saying
 * no, and the five minutes belong to the terminal rather than to the button.
 */
await realClick(client, '#undo-offer-hide');
await sleep(400);
r.ok(
  'the cross hides it',
  Boolean(await evaluate(client, `document.getElementById('undo-offer')?.hidden`)),
);

// Command+Z, which is undo everywhere else and has to be undo here.
await client.send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'z',
  code: 'KeyZ',
  modifiers: 4,
  windowsVirtualKeyCode: 90,
});
await client.send('Input.dispatchKeyEvent', {
  type: 'keyUp',
  key: 'z',
  code: 'KeyZ',
  modifiers: 4,
  windowsVirtualKeyCode: 90,
});
const back = await waitFor(client, 'window.__tabterm.paneIds().length === 2', 40000);
r.ok('Command+Z brings the pane back even after the button was hidden', back);

// Waited for: a restored pane draws its snapshot a moment after the layout says it exists, and
// under load that moment is longer than a read taken straight afterwards allows for.
await waitFor(
  client,
  `window.__tabterm.paneIds().some((p) => (window.__tabterm.readScreen(p) ?? '').includes('SECOND-PANE-MARKER'))`,
  30000,
);
const screens = JSON.parse(
  await evaluate(
    client,
    'JSON.stringify(window.__tabterm.paneIds().map((p) => window.__tabterm.readScreen(p)))',
  ),
);
r.ok(
  'and it is the same terminal, with what was in it',
  screens.some((s) => s.includes('SECOND-PANE-MARKER')),
  screens.map((s) => s.split('\n').filter(Boolean).slice(-1)[0]).join(' | '),
);

r.ok(
  'the offer is spent, so it cannot be taken twice',
  Boolean(await evaluate(client, `document.getElementById('undo-offer')?.hidden`)),
);

/**
 * Moving a pane to its own tab offers the way back too.
 *
 * The same promise as closing, because it is as easy to do by accident and just as final: the
 * pane is gone from here and the arrangement is one pane short.
 */
// Read again: the pane that came back is a new pane, with a new id.
const restored = String(await evaluate(client, 'window.__tabterm.paneIds()[1] ?? ""'));
await evaluate(client, `window.__tabterm.focus(${JSON.stringify(restored)})`);
await sleep(400);
await evaluate(client, 'window.__tabterm.detachPane()');
await sleep(3000);
const movedOut = await waitFor(client, 'window.__tabterm.paneIds().length === 1', 40000);
r.ok('moving a pane out leaves this tab with one', movedOut);

const moveBack = await waitFor(client, `!document.getElementById('undo-offer')?.hidden`, 30000);
const label = String(
  await evaluate(client, `document.getElementById('undo-offer-do')?.textContent ?? ''`),
);
r.ok('and offers to move it back', moveBack && /move/i.test(label), label);

await realClick(client, '#undo-offer-do');
const returned = await waitFor(client, 'window.__tabterm.paneIds().length === 2', 40000);
r.ok('which brings it back into this tab', returned);

await waitFor(
  client,
  `window.__tabterm.paneIds().some((p) => (window.__tabterm.readScreen(p) ?? '').includes('SECOND-PANE-MARKER'))`,
  30000,
);
const afterMove = JSON.parse(
  await evaluate(
    client,
    'JSON.stringify(window.__tabterm.paneIds().map((p) => window.__tabterm.readScreen(p)))',
  ),
);
r.ok(
  'still the same terminal, with its output',
  afterMove.some((s) => s.includes('SECOND-PANE-MARKER')),
  afterMove.map((s) => s.split('\n').filter(Boolean).slice(-1)[0]).join(' | '),
);

await finish();
r.done();
