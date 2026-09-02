// A session must not end while a tab for it exists in Chrome.
//
// The defect: a terminal expired seventeen hours after its last command with its tab still open.
// A backgrounded tab, one in a collapsed group, one on a machine that slept and one Chrome
// discarded to save memory all close their socket, and the daemon read that as nobody wanting
// the terminal any more. A socket is not a tab.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo KEEP-ME\r');
await sleep(1600);

const workspaceId = String(await evaluate(client, 'window.__tabterm.workspaceId()'));
r.ok('the tab has a workspace in its URL, which is what identifies it', workspaceId.length > 10);

// The extension reports what Chrome has open. Ask it what it would say.
const reported = JSON.parse(
  await evaluate(
    client,
    `(async () => {
       const base = chrome.runtime.getURL('terminal.html');
       const tabs = await chrome.tabs.query({ url: base + '*' });
       return JSON.stringify(tabs.map((t) => new URL(t.url).searchParams.get('workspace')).filter(Boolean));
     })()`,
  ),
);
r.ok(
  'and this tab is in what Chrome reports',
  reported.includes(workspaceId),
  JSON.stringify(reported.slice(0, 3)),
);

/**
 * The real test: drop the socket without closing the tab.
 *
 * That is exactly what a discarded tab, a slept machine and a dead service worker all look like
 * from the daemon. Before this fix, the background timer started here.
 */
await evaluate(client, `(() => { const t = window.__tabterm.transport(); return t; })()`);
const before = String(await evaluate(client, 'window.__tabterm.readScreen()'));
r.ok('the terminal has output in it to lose', before.includes('KEEP-ME'));

// A short timeout, so the wait is seconds rather than half an hour.
await evaluate(client, 'window.__tabterm.setBackgroundTimeout(1)');
await sleep(500);
await evaluate(client, 'window.__tabterm.dropConnection()');
await sleep(6000);

// Reconnect and see whether the session is still there.
await evaluate(client, 'window.__tabterm.reconnect()');
const alive = await waitFor(
  client,
  `(window.__tabterm.readScreen() ?? '').includes('KEEP-ME')`,
  15000,
);
r.ok(
  'the session survives its socket dropping while the tab is open',
  alive,
  String(await evaluate(client, 'window.__tabterm.readScreen()')).slice(0, 120),
);

await evaluate(client, 'window.__tabterm.setBackgroundTimeout(1800)');
await finish();
r.done();
