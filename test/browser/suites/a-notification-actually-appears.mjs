// A finished command actually becomes a desktop notification.
//
// Reported as notifications having stopped appearing. Everything on the way there was already
// checked: the policy round trip, the threshold, the favicon, the message reaching the worker. What
// was never checked is the last step, which is Chrome being asked to show one, and that is exactly
// where a fault would be invisible from everywhere else.
//
// `chrome.notifications.getAll` answers for the browser rather than for us, so this passes only if
// a notification really exists in Chrome. Whether the operating system then draws it is the one
// part no check can reach.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

const work = await openTerminal();
await waitFor(work.client, "document.querySelector('.launcher-input')");

/*
 * Five seconds rather than the minute it ships with, so a check does not have to wait one out.
 * Set through the settings panel, which is how a person sets it.
 */
await evaluate(work.client, `document.getElementById('cmd-button')?.click()`);
await sleep(600);
await evaluate(work.client, `document.querySelector('.cmd-gear')?.click()`);
await sleep(900);
const armed = String(
  await evaluate(
    work.client,
    `(() => {
       const rows = [...document.querySelectorAll('.set-field')];
       const master = rows.find((row) =>
         (row.textContent ?? '').includes('Tell me when something finishes'));
       const box = master?.querySelector('input[type=checkbox]');
       if (box && !box.checked) box.click();
       const picker = [...document.querySelectorAll('select')].find((sel) =>
         [...sel.options].some((o) => o.value === '5000'));
       if (!picker) return 'no picker';
       picker.value = '5000';
       picker.dispatchEvent(new Event('change', { bubbles: true }));
       return picker.value;
     })()`,
  ),
);
r.ok('the threshold can be set to five seconds', armed === '5000', armed);
await sleep(800);
await evaluate(work.client, `document.querySelector('.cmd-close')?.click()`);
await sleep(400);

/*
 * Looked away from, because "not for a pane I am already looking at" is on by default and doing
 * exactly what it says. A second tab in front is what makes this the case that should notify.
 */
const other = await openTerminal();
await waitFor(other.client, "document.querySelector('.launcher-input')");
await sleep(1000);

await type(work.client, 'sleep 7; echo NOTIFY-ME\r');
const ran = await waitUntil(
  async () =>
    String(await evaluate(work.client, `window.__tabterm.readScreen() ?? ''`)).includes(
      'NOTIFY-ME',
    ),
  30000,
);
r.ok('the command ran and finished', ran);

/*
 * Asked of Chrome, from a page that is not the one that ran the command. A notification that was
 * created and immediately withdrawn would not be here either, which is the other way this could
 * have been failing.
 */
const seen = await waitUntil(async () => {
  const all = String(
    await evaluate(
      other.client,
      `new Promise((done) => chrome.notifications.getAll((byId) => done(JSON.stringify(Object.keys(byId ?? {})))))`,
    ),
  );
  return JSON.parse(all).length > 0;
}, 15000);

const ids = String(
  await evaluate(
    other.client,
    `new Promise((done) => chrome.notifications.getAll((byId) => done(JSON.stringify(Object.keys(byId ?? {})))))`,
  ),
);
r.ok('and Chrome is holding a notification for it', seen, ids);

await finish();
r.done();
