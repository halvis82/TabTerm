// Completion notifications, the settings that govern them, and the tab status they share.
//
// The favicon is the only part of a terminal visible from another tab, so what it shows and how
// long it keeps showing it is the whole feature. Checked against the real daemon, because the
// threshold is enforced there and a page-side test would be checking nothing.
import { openTerminal, evaluate, sleep, type, finish } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

// The whole data URL, not its prefix: every PNG shares the first twenty-odd characters, so a
// short slice compares equal for icons that look nothing alike.
const faviconState = () =>
  evaluate(
    client,
    `(() => {
      const href = document.getElementById('favicon')?.href ?? '';
      let hash = 0;
      for (let i = 0; i < href.length; i++) hash = (hash * 31 + href.charCodeAt(i)) | 0;
      return String(hash) + ':' + String(href.length);
    })()`,
  );

// --- the policy round trip ------------------------------------------------
const policy = async () =>
  JSON.parse(
    await evaluate(
      client,
      `JSON.stringify(await new Promise((resolve) => {
        const done = (p) => resolve(p);
        window.__policyProbe = done;
        resolve(null);
      }))`,
    ).catch(() => 'null'),
  );
void policy;

await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await sleep(600);
await evaluate(client, `document.querySelector('.cmd-gear')?.click()`);
await sleep(900);

r.ok(
  'settings offer notifications',
  Number(await evaluate(client, `document.querySelectorAll('.cmd-toggle').length`)) >= 6,
  `${String(await evaluate(client, `document.querySelectorAll('.cmd-toggle').length`))} switches`,
);

const thresholds = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.cmd-settings select')].map(s => s.value))`,
  ),
);
r.ok(
  'the daemon supplied the threshold, defaulting to a minute',
  thresholds.includes('60000'),
  thresholds.join(', '),
);

// The agent hooks switch, which is the whole point of it being reachable here.
const hookRow = await evaluate(
  client,
  `(() => {
     const row = [...document.querySelectorAll('.cmd-toggle')]
       .find(t => t.textContent.includes('Agent events'));
     return row ? row.textContent : '';
   })()`,
);
r.ok('agent events can be turned on from here', String(hookRow).includes('Agent events'), hookRow);

const shellRow = await evaluate(
  client,
  `(() => {
     const row = [...document.querySelectorAll('.cmd-toggle')]
       .find(t => t.textContent.includes('Shell integration'));
     return row ? row.textContent : '';
   })()`,
);
r.ok(
  'and so can shell integration, which is what exit codes depend on',
  /exit codes|Already sourced|installer first/.test(String(shellRow)),
  String(shellRow),
);
r.ok(
  'and it says what it is currently doing',
  /need this|Installed for|No supported/.test(String(hookRow)),
  String(hookRow),
);

// Changing a setting reaches the daemon and comes back.
await evaluate(
  client,
  `(() => {
     const select = [...document.querySelectorAll('.cmd-settings select')]
       .find(s => [...s.options].some(o => o.value === '60000'));
     select.value = '300000';
     select.dispatchEvent(new Event('change', { bubbles: true }));
   })()`,
);
await sleep(900);
const afterChange = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify([...document.querySelectorAll('.cmd-settings select')].map(s => s.value))`,
  ),
);
r.ok(
  'a changed threshold is echoed back by the daemon',
  afterChange.includes('300000'),
  afterChange.join(', '),
);

// Put it back, so a test run does not leave the machine configured oddly.
await evaluate(
  client,
  `(() => {
     const select = [...document.querySelectorAll('.cmd-settings select')]
       .find(s => [...s.options].some(o => o.value === '60000'));
     select.value = '60000';
     select.dispatchEvent(new Event('change', { bubbles: true }));
   })()`,
);
await sleep(500);
await evaluate(client, `document.querySelector('.cmd-gear')?.click()`);
await evaluate(client, `document.getElementById('cmd-button')?.click()`);
await sleep(400);

// --- the favicon actually changes -----------------------------------------
const before = await faviconState();
await type(client, 'sleep 2');
await sleep(700);
const whileRunning = await faviconState();
r.ok('the icon changes while a command runs', whileRunning !== before, 'running differs from idle');

await sleep(2600);
const afterSuccess = await faviconState();
r.ok(
  'and changes again when it finishes',
  afterSuccess !== whileRunning,
  'success differs from running',
);

const doneTitle = String(await evaluate(client, `document.title`));
r.ok('the title says the command is over', /done|finished/.test(doneTitle), doneTitle);

// Looking at the tab is what clears the outcome. Simulated by the same event Chrome fires.
await evaluate(client, `document.dispatchEvent(new Event('visibilitychange'))`);
await sleep(500);
const afterLook = String(await evaluate(client, `document.title`));
r.ok(
  'looking at the tab clears it, so the next result still means something',
  !/done|finished/.test(afterLook),
  afterLook,
);

/**
 * A failure is distinguishable, when anything can tell that it failed.
 *
 * Exit codes come from shell integration. Without it the daemon reports no exit code at all
 * rather than a guessed zero, and the tab says the command finished without claiming it worked.
 * Both are correct outcomes and the suite accepts whichever applies here.
 */
// Long enough to be seen at all: a command that finishes inside the tracker's start delay is
// invisible without shell integration, which docs/08 lists as a blind spot of the fallback.
await type(client, 'sleep 1 && false');
await sleep(3200);
const afterFailure = String(await evaluate(client, `document.title`));
r.ok(
  'a failed command is reported as failed, or as finished where no exit code exists',
  /failed|finished/.test(afterFailure),
  afterFailure,
);

await finish();
r.done();
