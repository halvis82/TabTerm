// Dragging a pane's bar onto another pane exchanges the two.
//
// Driven with real drag events dispatched by the browser rather than with JavaScript ones made up
// in the page, for the same reason menus are driven with a real press and release: a handler can
// be wrong in a way only the real thing reaches. The events carry the drag's own payload, which
// is also what the handler reads.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo PANE-ONE\r');
await sleep(1400);
await evaluate(client, "window.__tabterm.split('horizontal')");
await sleep(3000);
await waitFor(client, 'window.__tabterm.paneIds().length === 2');

const order = () => evaluate(client, `JSON.stringify(window.__tabterm.paneIds())`);
const before = JSON.parse(String(await order()));
r.ok('two panes to begin with', before.length === 2, JSON.stringify(before));

// The pane bar is a drag handle, and the terminal is not: a drag starting on the terminal is a
// text selection, and trading that for reordering would be a bad bargain.
const draggable = String(
  await evaluate(client, "document.querySelector('.pane-bar')?.draggable ?? false"),
);
r.ok('the pane bar is the handle', draggable === 'true', draggable);

// Where the second pane is, so the drop lands on it rather than near it.
const box = JSON.parse(
  String(
    await evaluate(
      client,
      `(() => {
         const panes = [...document.querySelectorAll('.pane')];
         const b = panes[1].getBoundingClientRect();
         return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
       })()`,
    ),
  ),
);

const data = {
  items: [{ mimeType: 'application/x-tabterm-pane', data: before[0] }],
  // 16 is Move. The handler asks for `move` on dragover, and a mask that does not allow it makes
  // Chrome refuse the drop with no event and no error, which looks exactly like a dead handler.
  dragOperationsMask: 16,
};
await client.send('Input.dispatchDragEvent', { type: 'dragEnter', ...box, data });
await client.send('Input.dispatchDragEvent', { type: 'dragOver', ...box, data });
const marked = Number(
  await evaluate(client, "document.querySelectorAll('.pane.is-swap-target').length"),
);
r.ok('the pane under the pointer says it would take the drop', marked === 1, String(marked));

await client.send('Input.dispatchDragEvent', { type: 'drop', ...box, data });
await sleep(1500);

const after = JSON.parse(String(await order()));
r.ok(
  'the two panes have exchanged places',
  after[0] === before[1] && after[1] === before[0],
  `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
);
r.ok(
  'and nothing was left marked as a target',
  Number(await evaluate(client, "document.querySelectorAll('.pane.is-swap-target').length")) === 0,
);

// It survives a reload, because the layout is the daemon's rather than this page's.
await client.send('Page.reload');
await waitFor(client, 'window.__tabterm?.paneIds().length === 2', 25000);
const reloaded = JSON.parse(String(await order()));
r.ok(
  'and the new order is what comes back after a reload',
  reloaded[0] === after[0] && reloaded[1] === after[1],
  JSON.stringify(reloaded),
);

await finish();
r.done();
