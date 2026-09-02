// Failures say what happened, and stay where they happened.
//
// Two rules this pins. An error about one workspace concerns the tab showing it and nobody else,
// and what reaches a person names the thing that failed rather than a code or a number.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const recovery = (client) =>
  evaluate(client, "!!document.querySelector('#recovery:not([hidden])')");

// Two unrelated tabs, plus one that will take a session from the first.
const a = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(a.client, "document.querySelector('.launcher-input')");
await type(a.client, 'echo tab-A\r');
await sleep(1200);
const bystander = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(bystander.client, "document.querySelector('.launcher-input')");
await type(bystander.client, 'echo bystander\r');
await sleep(1200);
const taker = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(taker.client, "document.querySelector('.launcher-input')");
await evaluate(taker.client, "window.__tabterm.split('horizontal')");
await sleep(3000);

r.ok('nobody is showing an expiry to begin with', !(await recovery(bystander.client)));

const sessionOfA = String(
  await evaluate(a.client, 'JSON.parse(window.__tabterm.transport()).panes[0].sessionId'),
);
await evaluate(
  taker.client,
  `(() => {
     const row = document.querySelector('.pane-chooser-session[data-session^="${sessionOfA}"]');
     if (row) { row.click(); setTimeout(() => document.querySelector('.pane-chooser-session.is-confirming')?.click(), 300); }
   })()`,
);
await sleep(4000);

r.ok(
  'ending one workspace does not tell every other tab it expired',
  !(await recovery(bystander.client)),
  'the daemon tells every client, so the tab has to check the message is about itself',
);

// A failure a person can act on, rather than a code. Asking for a layout in a directory that
// cannot be created is a real failure with a real cause underneath it.
const fresh = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(fresh.client, "document.querySelector('.launcher-input')");
await evaluate(
  fresh.client,
  `(() => {
     const box = document.querySelector('.launcher-input');
     box.value = '/System/tabterm-cannot-create-this/here';
     [...document.querySelectorAll('.launcher-chip')].find((c) => c.firstChild?.textContent === 'Split in 2')?.click();
   })()`,
);
await sleep(2500);
const status = String(
  await evaluate(fresh.client, "document.querySelector('#status')?.textContent ?? ''"),
);
r.ok('a failure says what happened', /does not exist|no such/i.test(status), status);
r.ok('and never shows a bare code', !/path-not-found|internal|error 1/i.test(status), status);

await finish();
r.done();
