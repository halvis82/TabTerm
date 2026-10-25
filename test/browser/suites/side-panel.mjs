// A terminal in Chrome's side panel, beside a regular page.
//
// Asked for: opened from the toolbar icon's menu for the tab in front, a new session in home with
// the same folder picker and Bring a session here as a new split pane, and not offered on a
// TabTerm tab. Chrome cannot click the icon's menu or open a side panel without a person's
// gesture, so the worker's handler is called directly and the page is opened the way the side
// panel opens it.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  type,
  realClick,
  readScreen,
  EXT_ID,
} from '../helpers.mjs';
import { reporter, listTargets, connect } from '../cdp.mjs';

const r = reporter();

async function inWorker(expression) {
  const worker = (await listTargets()).find(
    (t) => t.type === 'service_worker' && t.url.includes(EXT_ID),
  );
  if (!worker) return null;
  const sw = connect(worker.webSocketDebuggerUrl);
  await sw.ready;
  await sw.send('Runtime.enable');
  const value = await evaluate(sw, expression);
  sw.close?.();
  return value;
}

// Something to bring here: a session in an ordinary TabTerm tab.
const other = await openTerminal();
await waitFor(other.client, "document.querySelector('.launcher-input')");
await type(other.client, 'echo SIDE-PANEL-DONOR');
await waitFor(other.client, "document.querySelector('.launcher')?.hidden === true", 10000);
await sleep(800);

// The worker sets the panel up for a regular page, and not for a TabTerm one.
const pageTab = Number(
  await inWorker(`chrome.tabs.create({ url: 'about:blank', active: false }).then((t) => t.id)`),
);
await inWorker(
  `chrome.tabs.get(${String(pageTab)}).then((t) => { __tabtermSidePanel(t); return 1; })`,
);
await sleep(400);
const pageOptions = JSON.parse(
  String(
    await inWorker(
      `chrome.sidePanel.getOptions({ tabId: ${String(pageTab)} }).then(JSON.stringify)`,
    ),
  ),
);
r.ok(
  'beside a regular page, the side panel is the terminal',
  pageOptions.path === 'terminal.html?sidepanel=1' && pageOptions.enabled === true,
  JSON.stringify(pageOptions),
);
const ownTab = Number(
  await inWorker(
    `chrome.tabs.query({ url: 'chrome-extension://${EXT_ID}/terminal.html*' }).then((ts) => ts[0].id)`,
  ),
);
await inWorker(
  `chrome.tabs.get(${String(ownTab)}).then((t) => { __tabtermSidePanel(t); return 1; })`,
);
await sleep(400);
const ownOptions = JSON.parse(
  String(
    await inWorker(
      `chrome.sidePanel.getOptions({ tabId: ${String(ownTab)} }).then(JSON.stringify)`,
    ),
  ),
);
r.ok(
  'beside a TabTerm tab it is not offered',
  ownOptions.path !== 'terminal.html?sidepanel=1',
  JSON.stringify(ownOptions),
);

// The page the panel loads, at a side panel's width.
const { client } = await openTerminal('?sidepanel=1');
await client.send('Emulation.setDeviceMetricsOverride', {
  width: 420,
  height: 760,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(600);
r.ok(
  'it knows it is in the side panel',
  (await evaluate(client, 'window.__tabterm.inSidePanel()')) === true,
);
r.ok(
  'it has a new shell rather than the start screen',
  await waitFor(
    client,
    "document.querySelector('.launcher')?.hidden !== false && window.__tabterm.paneIds().length === 1",
    10000,
  ),
);
r.ok(
  'in home',
  /~/.test(String(await readScreen(client))),
  String(await readScreen(client)).slice(0, 200),
);
r.ok(
  'with the new pane chooser over it',
  await waitFor(
    client,
    "window.__tabterm.choosersShown().length === 1 && !!document.querySelector('.pane-chooser .pane-chooser-take')",
    10000,
  ),
);
r.ok(
  'and its folder picker',
  Boolean(
    await evaluate(
      client,
      "!!document.querySelector('.pane-chooser .launcher-input, .pane-chooser input')",
    ),
  ),
);

await realClick(client, '.pane-chooser-take');
r.ok(
  'Bring a session here lists the session in the other tab',
  await waitFor(
    client,
    "document.querySelector('.take-bubble')?.textContent.includes('SIDE-PANEL-DONOR')",
    8000,
  ),
  String(await evaluate(client, "document.querySelector('.take-bubble')?.textContent ?? ''")).slice(
    0,
    300,
  ),
);
const shot = process.env['TT_SHOT_DIR'];
if (shot) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(`${shot}/side-panel.png`, Buffer.from(data, 'base64'));
}

await finish();
r.done();
