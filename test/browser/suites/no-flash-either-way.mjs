// A tab shows what it is, and never the other thing first.
//
// Both directions were reported. A tab with work in it flashed the start screen, and once that
// was held back, a tab that IS the start screen showed its terminal for most of a second and was
// then covered over. The tab does not know which it is until its screen arrives, so until then it
// shows neither.
//
// Sampled from the first moment the page can run anything, because by the time either has settled
// the answer is right and the fault is invisible.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

const WATCH = `(() => {
  window.__seen = [];
  const look = () => {
    const l = document.querySelector('.launcher');
    const pane = document.querySelector('.pane');
    const launcher = !!l && !l.hidden && l.getBoundingClientRect().height > 4;
    const term = !!pane && getComputedStyle(pane).visibility !== 'hidden' &&
                 pane.getBoundingClientRect().height > 4;
    const state = launcher ? 'start-screen' : term ? 'terminal' : 'neither';
    const last = window.__seen[window.__seen.length - 1];
    if (last === undefined || last.state !== state) {
      window.__seen.push({ state, at: Math.round(performance.now()) });
    }
  };
  clearInterval(window.__seenTimer);
  window.__seenTimer = setInterval(look, 25);
  look();
})()`;

/** A tab that has never been used, refreshed. It must land on the start screen and show only it. */
{
  const fresh = await openTerminal();
  await waitFor(fresh.client, "document.querySelector('.launcher-input')");
  await sleep(1200);
  await evaluate(fresh.client, `(() => { ${WATCH} })()`);
  await evaluate(fresh.client, 'location.reload()');
  await sleep(400);
  await evaluate(fresh.client, WATCH);
  await waitFor(fresh.client, `!document.querySelector('.launcher')?.hidden`, 15000);
  await sleep(500);
  await evaluate(fresh.client, 'clearInterval(window.__seenTimer)');
  const seen = JSON.parse(await evaluate(fresh.client, 'JSON.stringify(window.__seen)'));
  r.ok(
    'refreshing the start screen never shows the terminal on the way',
    !seen.some((s) => s.state === 'terminal'),
    JSON.stringify(seen),
  );
  r.ok(
    'and lands on the start screen',
    seen[seen.length - 1]?.state === 'start-screen',
    JSON.stringify(seen),
  );
}

/** And a tab with work in it, reopened, must show only its terminal. */
{
  const worked = await openTerminal();
  await waitFor(worked.client, "document.querySelector('.launcher-input')");
  await type(worked.client, 'echo NO-FLASH-EITHER-WAY');
  await sleep(2200);
  const workspace = String(
    await evaluate(worked.client, `new URL(location.href).searchParams.get('workspace') ?? ''`),
  );
  r.ok('a tab with work in it', workspace !== '');

  const revisit = await openTerminal(`?workspace=${workspace}`);
  await evaluate(revisit.client, WATCH);
  await waitFor(
    revisit.client,
    `(window.__tabterm?.readScreen() ?? '').includes('NO-FLASH-EITHER-WAY')`,
    20000,
  );
  await sleep(600);
  await evaluate(revisit.client, 'clearInterval(window.__seenTimer)');
  const seen = JSON.parse(await evaluate(revisit.client, 'JSON.stringify(window.__seen)'));
  r.ok(
    'reopening a tab with work never shows the start screen on the way',
    !seen.some((s) => s.state === 'start-screen'),
    JSON.stringify(seen),
  );
  r.ok(
    'and lands on the terminal',
    seen[seen.length - 1]?.state === 'terminal',
    JSON.stringify(seen),
  );
}

await finish();
r.done();
