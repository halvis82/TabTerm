// The way out when something has gone wrong.
//
// Only the parts that destroy nothing are exercised here: the confirmation itself, what it says,
// and cancelling. Actually resetting ends every terminal on the machine, which is not something a
// test run should do to somebody's session. See docs/04-session-lifecycle.md.
import { openTerminal, evaluate, sleep } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

// A session, so the confirmation has something to count.
await openTerminal();
await sleep(1500);

const page = await openTerminal('?panel=reset');
await sleep(3500);

r.ok(
  'the reset entry asks before it acts',
  (await evaluate(page.client, `!!document.querySelector('.reset-card')`)) === true,
);

const body = String(
  await evaluate(page.client, `document.querySelector('.reset-body')?.textContent`),
);
r.ok('and says how much it will destroy, in numbers', /\d+ terminal session/.test(body), body);

r.ok(
  'it spells out what goes',
  Number(await evaluate(page.client, `document.querySelectorAll('.reset-list li').length`)) === 3,
);

r.ok(
  'cancel holds the focus, so return does not reset anything',
  (await evaluate(page.client, `document.activeElement?.className`)) === 'reset-cancel',
);

r.ok(
  'the destructive button is not styled as the ordinary one',
  (await evaluate(
    page.client,
    `(() => {
       const confirm = document.querySelector('.reset-confirm');
       const cancel = document.querySelector('.reset-cancel');
       if (!confirm || !cancel) return false;
       return getComputedStyle(confirm).color !== getComputedStyle(cancel).color;
     })()`,
  )) === true,
);

r.ok(
  'restarting the service is offered rather than assumed silently',
  (await evaluate(page.client, `!!document.querySelector('.reset-option input')`)) === true,
);

// Leave without touching anything.
await evaluate(page.client, `document.querySelector('.reset-cancel')?.click()`);

r.done();
