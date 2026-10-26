// Searching every terminal from the find bar, with All terminals ticked.
//
// Asked for: "it shouldn't take away from any existing functionality, it should only be an optional
// thing in the cmd f search interface. like you can check a box and it stays persistent". So the
// bar searches the pane in front as always, and with the box ticked it also lists what every other
// running terminal has, and pressing a match opens that terminal on it, here in another tab.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const TAG = `every-${String(Date.now()).slice(-6)}`;

// A terminal with the words in it, in a tab of its own.
const a = await openTerminal();
await waitFor(a.client, "document.querySelector('.launcher-input')");
await type(a.client, `echo ${TAG}-needle\r`);
await waitFor(a.client, `(window.__tabterm.readScreen() ?? '').includes('${TAG}-needle')`, 15000);
const aSession = String(
  await evaluate(a.client, 'JSON.parse(JSON.stringify(window.__tabterm.paneFacts()))[0].sessionId'),
);

// And another tab, where the search is made.
const b = await openTerminal();
await waitFor(b.client, "document.querySelector('.launcher-input')");
await type(b.client, 'echo nothing-to-see\r');
await sleep(800);
const openFind = () =>
  evaluate(
    b.client,
    `document.querySelector('.xterm-helper-textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }))`,
  );
const search = (q) =>
  evaluate(
    b.client,
    `(() => { const i = document.getElementById('find-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`,
  );
await openFind();
await sleep(300);
r.ok(
  'the box is there, and off unless ticked',
  await evaluate(b.client, `document.getElementById('find-all-box')?.checked === false`),
);
await search(`${TAG}-needle`);
await sleep(800);
r.ok(
  'and off, the bar searches this pane only, as it always has',
  await evaluate(b.client, `document.getElementById('find-results').hidden === true`),
);

await evaluate(b.client, `document.getElementById('find-all-box').click()`);
const lines = () =>
  evaluate(
    b.client,
    `JSON.stringify([...document.querySelectorAll('#find-results .find-all-line')].map((l) => l.textContent))`,
  ).then((s) => JSON.parse(String(s)));
r.ok(
  'ticked, it lists the match in the other tab',
  await waitUntil(async () => (await lines()).some((l) => l.includes(`${TAG}-needle`)), 8000),
  await lines(),
);

if (process.env.TT_SHOT_DIR) {
  const { data } = await b.client.send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(
    `${process.env.TT_SHOT_DIR}/find-all.png`,
    Buffer.from(data, 'base64'),
  );
}

// Pressing it brings that tab forward, on that match: the newest of the two there, the command
// typed being the other.
await evaluate(
  b.client,
  `[...document.querySelectorAll('#find-results .find-all-line')].find((l) => l.textContent.includes(${JSON.stringify(`${TAG}-needle`)}))?.click()`,
);
r.ok(
  'pressing it opens that terminal with the find bar on the match',
  await waitUntil(
    async () =>
      (await evaluate(
        a.client,
        `document.getElementById('find')?.hidden === false && document.getElementById('find-input').value === ${JSON.stringify(`${TAG}-needle`)} && document.getElementById('find-count').textContent === '2 of 2'`,
      )) === true,
    15000,
  ),
  String(await evaluate(a.client, `document.getElementById('find-count')?.textContent`)),
);
r.ok(
  'in the pane holding it',
  String(
    await evaluate(
      a.client,
      'window.__tabterm.paneFacts().find((p) => p.paneId === window.__tabterm.focusedPane())?.sessionId',
    ),
  ) === aSession,
);

// Remembered: a new tab opens the bar with the box ticked.
const c = await openTerminal();
await waitFor(c.client, "document.querySelector('.launcher-input')");
await sleep(500);
r.ok(
  'and the box stays ticked, in every tab, until it is unticked',
  await evaluate(c.client, `document.getElementById('find-all-box')?.checked === true`),
);
await evaluate(c.client, `document.getElementById('find-all-box').click()`);
await sleep(300);
await finish();
r.done();
