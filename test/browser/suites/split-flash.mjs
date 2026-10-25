// The finish flash in a tab of several panes keeps the split icon and flashes the half that
// finished.
//
// Asked for: "when we have the flash the tab when a command finishes, that should be compatible
// with the split screen icon thing we set up earlier. so it should be flashing in split screen if
// the given tab has multiple sessions". Driven through the real hook bridge.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  openPaneMenu,
  realClick,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo SPLIT-FLASH');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('SPLIT-FLASH')`, 20000);
await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1500);

const port = Number(process.env['TT_DAEMON_PORT'] ?? '7377') + 1;
const token = process.env['TT_DAEMON_TOKEN'] ?? '';
const [a, b] = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')),
);
const hook = async (pane, name) => {
  const res = await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
    method: 'POST',
    headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: pane.sessionId, hook: name }),
  });
  if (res.status !== 204) throw new Error(`${name} answered ${String(res.status)}`);
  await sleep(400);
};

// The flash on for the left pane's session, from its own menu.
await openPaneMenu(client, 60, 60);
await sleep(250);
await realClick(client, '.term-menu-item', 'Flash the tab when a command finishes');
await sleep(300);
const leftSession = String(await evaluate(client, `window.__tabterm.paneSessions()[0].sessionId`));
const finisher = leftSession === a.sessionId ? a : b;
const other = finisher === a ? b : a;

await hook(other, 'UserPromptSubmit');
await hook(finisher, 'UserPromptSubmit');
await hook(finisher, 'Stop');
r.ok(
  'a turn ending flashes the tab',
  await waitFor(client, 'window.__tabterm.flashing() === true', 3000),
);
await sleep(600);
const frame = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.flashFrame())')),
);
r.ok(
  'in the split icon: the finished half flashes and the working half still says working',
  frame.length === 2 &&
    frame.includes('running') &&
    frame.some((s) => s === 'attention' || s === 'attention-alt'),
  JSON.stringify(frame),
);

await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft' });
r.ok('and a key stops it', await waitFor(client, 'window.__tabterm.flashing() === false', 3000));

await finish();
r.done();
