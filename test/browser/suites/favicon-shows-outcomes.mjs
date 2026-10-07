// The tab's icon says what the session is doing, for a shell and for an agent alike.
//
// Asked for: "whenever a command is running or agent is working, that's shown as progress
// through favicon, when done either green checkmark or red cross ... when anything is done on
// the tab or it's navigated to, it should go back to normal". The shell half of this existed and
// the agent half did not: an agent's turn ending went straight back to idle. Both halves are
// driven here the way they happen, a real command and real hook posts to the bridge.
import { openTerminal, evaluate, type, waitFor, sleep, finish, press } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, 'window.__tabterm?.paneIds().length > 0', 20000);
await client.send('Page.bringToFront');
await sleep(800);

const icon = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.faviconNow())')));
const href = async () =>
  String(await evaluate(client, "document.querySelector('link[rel=\"icon\"]')?.href ?? ''"));

// A shell command: busy while it runs, then its outcome.
await type(client, 'sleep 2');
await sleep(700);
const busy = await icon();
r.ok('a running command shows progress', busy.showing === 'running', busy.showing);
const frameA = await href();
await sleep(450);
const frameB = await href();
r.ok(
  'and the progress mark moves while the tab is in front',
  frameA !== frameB && frameA.startsWith('data:'),
);
await waitFor(client, "window.__tabterm.faviconNow().showing === 'success'", 5000);
r.ok('a command that exited zero shows the green tick', (await icon()).showing === 'success');

// Doing anything in the tab puts it back to normal.
await press(client, 'a', 'KeyA', 0, 65);
await sleep(300);
r.ok(
  'typing in the tab puts the icon back to normal',
  (await icon()).showing === 'idle',
  (await icon()).showing,
);
await press(client, 'Backspace', 'Backspace', 0, 8);

await type(client, 'false');
await waitFor(client, "window.__tabterm.faviconNow().showing === 'failed'", 5000);
r.ok('a command that exited non-zero shows the red cross', (await icon()).showing === 'failed');
await evaluate(
  client,
  `(() => { const el = document.querySelector('.pane .xterm-screen'); const b = el.getBoundingClientRect();
     el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: b.left + 20, clientY: b.top + 20 })); return 'ok'; })()`,
);
await sleep(300);
r.ok(
  'a press in the tab puts it back to normal too',
  (await icon()).showing === 'idle',
  (await icon()).showing,
);

// An agent's turn: the same, driven by its hooks.
const port = Number(process.env['TT_DAEMON_PORT'] ?? '7377') + 1;
const token = process.env['TT_DAEMON_TOKEN'] ?? '';
const sessionId = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')),
)[0].sessionId;
const hook = async (name) => {
  const res = await fetch(`http://127.0.0.1:${String(port)}/agent-event`, {
    method: 'POST',
    headers: { 'x-tabterm-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, hook: name }),
  });
  if (res.status !== 204) throw new Error(`${name} answered ${String(res.status)}`);
  await sleep(500);
};
await hook('UserPromptSubmit');
r.ok(
  'an agent working shows progress',
  (await icon()).showing === 'running',
  (await icon()).showing,
);
await sleep(1100);
await hook('Stop');
const stopped = await icon();
r.ok(
  'an agent turn that ended shows the green tick',
  stopped.showing === 'success',
  JSON.stringify(stopped.panes),
);

// Navigating to the tab, which a reload is the strongest form of, shows nothing to notice.
await evaluate(client, 'location.reload()');
await sleep(3000);
await waitFor(client, 'window.__tabterm?.paneIds().length > 0', 25000);
await sleep(1200);
const back = await icon();
r.ok(
  'a tab navigated to after the turn is back to normal',
  back.showing === 'idle',
  JSON.stringify(back.panes),
);

await finish();
r.done();
