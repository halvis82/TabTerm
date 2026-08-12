// Splits, and the layout surviving a tab being closed and reopened.
import { openTerminal, evaluate, paneCount, sleep, newTab, connect } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

// Wait for focus to settle rather than assuming: a split issued before the first render is
// silently dropped, because the action needs a focused pane and there is not one yet.
for (let i = 0; i < 20; i++) {
  if (await evaluate(client, `!!document.querySelector('.pane.focused')`)) break;
  await sleep(200);
}

await evaluate(client, `window.__tabterm.split('horizontal')`);
await sleep(2500);
r.ok('a pane splits', (await paneCount(client)) === 2, `${String(await paneCount(client))} panes`);

await evaluate(client, `window.__tabterm.split('vertical')`);
await sleep(2500);
r.ok('and splits again', (await paneCount(client)) === 3);

const workspaceId = await evaluate(client, `window.__tabterm.workspaceId()`);
const pids = await evaluate(client, `JSON.stringify(window.__tabterm.paneIds())`);
r.ok(
  'the workspace has an id to restore by',
  typeof workspaceId === 'string' && workspaceId.length > 0,
);

// Reopen the same workspace in a new tab, which is what Chrome does on restore.
const tab = await newTab(
  `chrome-extension://${(await import('../helpers.mjs')).EXT_ID}/terminal.html?workspace=${workspaceId}`,
);
const restored = connect(tab.webSocketDebuggerUrl);
await restored.ready;
await restored.send('Runtime.enable');
await sleep(5000);

r.ok(
  'reopening the workspace URL restores every pane',
  (await paneCount(restored)) === 3,
  `${String(await paneCount(restored))} panes`,
);
r.ok(
  'and they are the same panes, not new ones',
  (await evaluate(restored, `JSON.stringify(window.__tabterm.paneIds())`)) === pids,
);

r.done();
