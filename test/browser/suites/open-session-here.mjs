// "Open a session here" on any pane's menu: the Running now bubble, minus this tab's sessions,
// and the session that was in the pane kept running rather than ended.
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

// The session to bring, in a tab of its own.
const donor = await openTerminal();
await waitFor(donor.client, "document.querySelector('.launcher-input')");
await type(donor.client, 'echo OPEN-HERE-DONOR');
await waitFor(donor.client, "document.querySelector('.launcher')?.hidden === true", 10000);
await sleep(800);
const donorSession = String(
  await evaluate(donor.client, 'window.__tabterm.paneSessions()[0].sessionId'),
);

// The tab doing the asking, with a pane somebody has used.
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo OPEN-HERE-WORK');
await waitFor(client, "document.querySelector('.launcher')?.hidden === true", 10000);
await sleep(800);
const mine = String(await evaluate(client, 'window.__tabterm.paneSessions()[0].sessionId'));

await openPaneMenu(client, 80, 90);
await sleep(250);
await realClick(client, '.term-menu-item', 'Open a session here');
r.ok(
  'the pane menu opens the bubble',
  await waitFor(
    client,
    "document.querySelector('.take-bubble-title')?.textContent === 'Open a session here'",
    5000,
  ),
);
r.ok(
  'listing the session in the other tab',
  await waitFor(
    client,
    `!!document.querySelector('.take-bubble [data-session-id="${donorSession}"]')`,
    8000,
  ),
);
r.ok(
  'and not this tab’s own',
  !(await evaluate(client, `!!document.querySelector('.take-bubble [data-session-id="${mine}"]')`)),
);

// It is in another tab, so the first press asks and the second moves it.
const card = `.take-bubble [data-session-id="${donorSession}"]`;
await realClick(client, card);
await sleep(300);
await realClick(client, card);
r.ok(
  'choosing it shows it in this pane',
  await waitFor(
    client,
    `window.__tabterm.paneSessions()[0]?.sessionId === ${JSON.stringify(donorSession)}`,
    8000,
  ),
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')),
);

// The session that was here is still alive, in the background.
await evaluate(client, 'window.__tabterm.refreshLive?.()');
await sleep(1500);
const alive = await waitFor(
  client,
  `(window.__tabterm.liveSessions?.() ?? []).some((s) => s.sessionId === ${JSON.stringify(mine)})`,
  8000,
);
r.ok(
  'and what was in the pane keeps running',
  alive,
  String(
    await evaluate(
      client,
      'JSON.stringify((window.__tabterm.liveSessions?.() ?? []).map((s) => s.sessionId))',
    ),
  ),
);

await finish();
r.done();
