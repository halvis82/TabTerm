// A tab that is reattaching goes to its terminal, and never shows the start screen on the way.
//
// Reported as: reopening a tab with a session in it "loads initially with the homescreen first
// and then it switches to the correct screen when it has fully loaded. it just feels misleading".
// Taking a moment to load is fine. Showing the wrong thing first is not, and it cannot be checked
// by looking at the end state, because by then it is right.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const first = await openTerminal();
await waitFor(first.client, "document.querySelector('.launcher-input')");
await type(first.client, 'echo STRAIGHT-TO-VIEW');
await sleep(2500);
const workspace = String(
  await evaluate(first.client, `new URL(location.href).searchParams.get('workspace') ?? ''`),
);
r.ok('a tab with a session in it', workspace !== '', workspace);

if (workspace !== '') {
  /**
   * Opened as a genuinely new tab, which is what the service worker does after a reload.
   *
   * Sampled from the first moment the page can run anything, because the whole question is what
   * is on screen before the answer arrives.
   */
  const revisit = await openTerminal(`?workspace=${workspace}`);
  await evaluate(
    revisit.client,
    `(() => {
       window.__seen = [];
       const look = () => {
         const l = document.querySelector('.launcher');
         const shown = !!l && !l.hidden && l.getBoundingClientRect().height > 4;
         const last = window.__seen[window.__seen.length - 1];
         if (last === undefined || last.shown !== shown) {
           window.__seen.push({
             shown,
             at: Math.round(performance.now()),
             exists: !!l,
             hiddenAttr: l ? l.hidden : null,
             h: l ? Math.round(l.getBoundingClientRect().height) : null,
             panelOpen: document.documentElement.classList.contains('panel-open') ||
                        document.body.classList.contains('panel-open'),
           });
         }
       };
       clearInterval(window.__seenTimer);
       window.__seenTimer = setInterval(look, 30);
       look();
     })()`,
  );
  await waitFor(
    revisit.client,
    `(window.__tabterm?.readScreen() ?? '').includes('STRAIGHT-TO-VIEW')`,
    20000,
  );
  await sleep(600);
  await evaluate(revisit.client, 'clearInterval(window.__seenTimer)');
  const seen = JSON.parse(await evaluate(revisit.client, 'JSON.stringify(window.__seen)'));

  r.ok(
    'the start screen is never shown while a tab is reattaching',
    !seen.some((s) => s.shown),
    JSON.stringify(seen),
  );
  r.ok(
    'and the session it was opened for is what is on screen',
    String(await evaluate(revisit.client, `window.__tabterm.readScreen()`)).includes(
      'STRAIGHT-TO-VIEW',
    ),
  );
}

await finish();
r.done();
