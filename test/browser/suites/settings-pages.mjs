// Settings, a page at a time: tabs for what the settings are about, and a search across them.
//
// Asked for as: "make settings look nice and easy to use. it's currently too cluttered and hard to
// understand what's what and unorganized." Some thirty controls had grown into one column.
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await evaluate(client, 'localStorage.removeItem("tabterm.settingsPage")');
const open = async () => {
  await evaluate(client, "document.querySelector('#cmd-button')?.click()");
  await waitFor(client, "document.querySelector('.cmd-panel')?.hidden === false");
  await evaluate(client, "document.querySelector('.cmd-gear')?.click()");
  await waitFor(client, "document.querySelector('.set-nav')");
};
await open();
const shown = () =>
  evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.set-page')].filter((p) => !p.hidden).map((p) => p.dataset.settingsPageBody))`,
  ).then((s) => JSON.parse(String(s)));
const tabs = JSON.parse(
  String(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.set-nav-tab')].map((b) => b.textContent))`,
    ),
  ),
);
r.ok(
  'Settings is in pages, named for what is on them',
  ['Theme', 'Terminals', 'Agents', 'Alerts', 'Keys', 'About'].every((t) => tabs.includes(t)),
  tabs,
);
r.ok('and opens on one page', (await shown()).length === 1, await shown());
r.ok(
  'with its tabs on one line',
  await evaluate(
    client,
    `new Set([...document.querySelectorAll('.set-nav-tab')].map((b) => b.offsetTop)).size === 1`,
  ),
);

const shots = process.env.TT_SHOT_DIR;
const shot = async (name) => {
  if (!shots) return;
  await sleep(250);
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${shots}/settings-${name}.png`, Buffer.from(data, 'base64'));
};
for (const page of [
  'appearance',
  'terminals',
  'agents',
  'notifications',
  'remote',
  'shortcuts',
  'about',
]) {
  await evaluate(client, `document.querySelector('[data-settings-page="${page}"]')?.click()`);
  await shot(page);
}

await evaluate(client, `document.querySelector('[data-settings-page="terminals"]').click()`);
r.ok(
  'a tab shows its page and only its page',
  JSON.stringify(await shown()) === '["terminals"]',
  await shown(),
);
r.ok(
  'and the tab says so',
  await evaluate(
    client,
    `document.querySelector('[data-settings-page="terminals"]').classList.contains('on')`,
  ),
);
r.ok(
  'finished and failed is with the terminal settings now, not notifications',
  await evaluate(
    client,
    `[...document.querySelectorAll('[data-settings-page-body="terminals"] .set-label')].some((l) => l.textContent === 'Show whether each command succeeded or failed')`,
  ),
);

// The search looks through every page.
await evaluate(
  client,
  `(() => { const s = document.querySelector('.set-search'); s.value = 'bell'; s.dispatchEvent(new Event('input')); })()`,
);
const visibleLabels = () =>
  evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.set-page .set-label')].filter((l) => l.offsetParent !== null).map((l) => l.textContent))`,
  ).then((s) => JSON.parse(String(s)));
r.ok(
  'searching finds a setting on any page, and only what matches',
  JSON.stringify(await visibleLabels()) === '["Flash when a program rings the bell"]',
  await visibleLabels(),
);
await shot('search');
await evaluate(
  client,
  `(() => { const s = document.querySelector('.set-search'); s.value = 'zzzz nothing'; s.dispatchEvent(new Event('input')); })()`,
);
r.ok(
  'and says so when nothing matches',
  await evaluate(client, `!document.querySelector('.set-search-empty').hidden`),
);
await evaluate(
  client,
  `(() => { const s = document.querySelector('.set-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`,
);

// Closed and opened again, it is on the page last used.
await evaluate(client, "document.querySelector('.cmd-gear')?.click()");
await sleep(200);
await evaluate(client, "document.querySelector('.cmd-gear')?.click()");
await waitFor(client, "document.querySelector('.set-nav')");
r.ok(
  'and opens again on the page last used',
  JSON.stringify(await shown()) === '["terminals"]',
  await shown(),
);
// Restore all settings brings back what this page keeps as well as what the daemon keeps, and
// leaves the shortcut on an action somebody made alone.
await evaluate(
  client,
  `chrome.storage.local.set({
     'tabterm.labelOpacity': 0.45,
     'tabterm.showBell': false,
     'tabterm.copyOutputLines': 50,
     'tabterm.findAll': true,
     'tabterm.pageShortcuts': [{ id: 'close-pane', keys: 'Control+Meta+K' }, { id: 'action:mine', keys: 'Control+Meta+J' }],
   })`,
);
await evaluate(client, `document.querySelector('[data-settings-page="about"]').click()`);
await evaluate(
  client,
  `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Restore all settings')?.click()`,
);
await evaluate(
  client,
  `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Yes, restore all settings')?.click()`,
);
const kept = async () =>
  JSON.parse(
    String(
      await evaluate(
        client,
        `chrome.storage.local.get(['tabterm.labelOpacity', 'tabterm.showBell', 'tabterm.copyOutputLines', 'tabterm.findAll', 'tabterm.pageShortcuts']).then((s) => JSON.stringify(s))`,
      ),
    ),
  );
await sleep(800);
const after = await kept();
r.ok(
  'Restore all settings brings back the ones this page keeps',
  after['tabterm.labelOpacity'] === undefined &&
    after['tabterm.showBell'] === undefined &&
    after['tabterm.copyOutputLines'] === undefined &&
    after['tabterm.findAll'] === undefined,
  after,
);
r.ok(
  'and the shipped shortcuts, keeping the one on an action somebody made',
  JSON.stringify(after['tabterm.pageShortcuts']) ===
    JSON.stringify([{ id: 'action:mine', keys: 'Control+Meta+J' }]),
  after['tabterm.pageShortcuts'],
);
await finish();
r.done();
