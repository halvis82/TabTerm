// "Flash the tab when a command finishes" fires for an agent's turn, not only a shell's command.
//
// The toggle was on in an agent session and nothing happened when the agent finished: the flash
// was started by a command ending, and an agent's turn ends with a hook. Driven through the real
// hook bridge, the way agent-favicon does it.
import {
  openTerminal,
  evaluate,
  waitFor,
  sleep,
  finish,
  type,
  openPaneMenu,
  realClick,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo agent-flash');
await waitFor(client, "document.querySelector('.launcher')?.hidden === true", 10000);
await sleep(600);

const port = Number(process.env['TT_DAEMON_PORT'] ?? '7377') + 1;
const token = process.env['TT_DAEMON_TOKEN'] ?? '';
const panes = await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())');
const sessionId = JSON.parse(String(panes))[0]?.sessionId ?? '';
r.ok('the tab has a session for a hook to report against', sessionId !== '', String(panes));

async function hook(name) {
  const res = await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
    method: 'POST',
    headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, hook: name }),
  });
  if (res.status !== 204) throw new Error(`${name} answered ${String(res.status)}`);
  await sleep(400);
}
const flashing = () => evaluate(client, 'window.__tabterm.flashing()');

// Off by default: a turn ending flashes nothing.
await hook('UserPromptSubmit');
await hook('Stop');
await sleep(600);
r.ok('with the toggle off, a finished turn flashes nothing', !(await flashing()));

await openPaneMenu(client, 60, 60);
await sleep(250);
await realClick(client, '.term-menu-item', 'Flash the tab when a command finishes');
await sleep(300);

await hook('UserPromptSubmit');
r.ok('a turn starting flashes nothing', !(await flashing()));
await hook('Stop');
r.ok(
  'a turn ending flashes the tab',
  await waitFor(client, 'window.__tabterm.flashing() === true', 3000),
);

// Noticed: a key is a sign of a person, and the flash stops.
await type(client, '', { submit: false });
await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft' });
r.ok('and a key stops it', await waitFor(client, 'window.__tabterm.flashing() === false', 3000));

await hook('UserPromptSubmit');
await hook('Notification');
r.ok(
  'the agent stopping to ask flashes it too',
  await waitFor(client, 'window.__tabterm.flashing() === true', 3000),
);

await finish();
r.done();
