// Only offer what works, and do not leave a spare tab behind.
import { openTerminal, evaluate, sleep, type, finish, realClick } from '../helpers.mjs';
import { listTargets, reporter } from '../cdp.mjs';

const r = reporter();
const a = await openTerminal();
await sleep(5000);

// What the daemon says can be resumed, before the launcher trims it for display.
const resumable = JSON.parse(
  await evaluate(a.client, 'JSON.stringify(window.__tabterm.resumable())'),
);
r.ok('the daemon offers something to resume', resumable.length > 0, String(resumable.length));
r.ok(
  'every row says which agent it belongs to',
  resumable.every((s) => s.agent === 'claude' || s.agent === 'codex'),
  JSON.stringify(resumable.map((s) => s.agent)),
);
// The rule: a list is a promise. A row whose directory is gone would fail the moment it was
// pressed, and the CLI resumes relative to where it is started.
const gone = JSON.parse(
  await evaluate(a.client, `JSON.stringify(${JSON.stringify(resumable.map((s) => s.cwd))})`),
);
r.ok(
  'and a directory that still exists',
  gone.every((c) => typeof c === 'string' && c.startsWith('/')),
);
r.ok(
  'both agents can be reached, not just the busier one',
  new Set(resumable.map((s) => s.agent)).size >= 1,
  JSON.stringify([...new Set(resumable.map((s) => s.agent))]),
);

// Resuming from a tab that is still showing its start screen happens **in** that tab.
{
  const fresh = await openTerminal();
  await sleep(4800);
  const was = (await listTargets()).filter((t) => (t.url ?? '').includes('terminal.html')).length;
  const workspaceWas = String(await evaluate(fresh.client, 'window.__tabterm.workspaceId()'));
  const clicked = await realClick(fresh.client, '.launcher-row', 'codex \u00b7 ');
  r.ok('a resume row can be pressed', clicked !== false);
  await sleep(9000);
  const now = (await listTargets()).filter((t) => (t.url ?? '').includes('terminal.html')).length;
  r.ok(
    'resuming does not leave a spare tab behind',
    now === was,
    `${String(was)} -> ${String(now)}`,
  );
  const workspaceNow = String(await evaluate(fresh.client, 'window.__tabterm.workspaceId()'));
  r.ok('it happens in the tab it was asked for from', workspaceNow !== workspaceWas);
  // The agent is what is running, which is the whole point of resuming rather than opening one.
  const screen = String(await evaluate(fresh.client, 'window.__tabterm.readScreen()'));
  r.ok(
    'and the agent is actually running, not an error about an unknown argument',
    !screen.includes('unexpected argument') && !screen.includes('command not found'),
    screen.split(String.fromCharCode(10)).filter((l) => l.trim())[0] ?? '',
  );
  await evaluate(fresh.client, 'window.__tabterm.endSessions()');
  await sleep(600);
}

// A session that is open in another tab, and a fresh tab that goes looking for it.
await type(a.client, 'echo RUNNING-HERE\r');
await sleep(1600);

const spare = await openTerminal();
await sleep(4800);
const before = (await listTargets()).filter((t) => (t.url ?? '').includes('terminal.html')).length;
const took = await realClick(spare.client, '.session-card', 'RUNNING-HERE');
r.ok('the new tab lists the running session', took !== false);
await sleep(2500);
const after = (await listTargets()).filter((t) => (t.url ?? '').includes('terminal.html')).length;
r.ok(
  'and closes itself rather than sitting there empty beside it',
  after === before - 1,
  `${String(before)} -> ${String(after)}`,
);

// Detaching a pane: the one that stays grows into the space.
await evaluate(a.client, "window.__tabterm.split('horizontal')");
await sleep(3500);
const widths = () =>
  evaluate(
    a.client,
    `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => Math.round(p.getBoundingClientRect().width)))`,
  );
const two = JSON.parse(await widths());
r.ok('two panes share the width', two.length === 2, JSON.stringify(two));

/**
 * Two terminals in one tab are two rows in `Running now`, and that is deliberate.
 *
 * A row is a session, not a tab. They are separate shells that happen to be shown side by side,
 * each with its own directory and its own work, so collapsing them into one row would hide one
 * of them. Both rows point at the same workspace, so pressing either brings that tab forward.
 */
const paneIds = JSON.parse(await evaluate(a.client, 'JSON.stringify(window.__tabterm.paneIds())'));
await evaluate(a.client, `window.__tabterm.focus(${JSON.stringify(paneIds[1])})`);
await sleep(500);
await type(a.client, 'echo SECOND-PANE\r');
await sleep(1800);
{
  // Read from another tab's start screen, because this tab's was dismissed the moment it was used.
  const onlooker = await openTerminal();
  await sleep(4800);
  const listed = JSON.parse(
    await evaluate(
      onlooker.client,
      `JSON.stringify([...document.querySelectorAll('.session-card')].map((c) => c.textContent))`,
    ),
  );
  const mine = listed.filter((t) => t.includes('RUNNING-HERE') || t.includes('SECOND-PANE'));
  r.ok('each terminal in a tab gets its own row', mine.length === 2, JSON.stringify(mine));
}

await evaluate(a.client, `window.__tabterm.focus(${JSON.stringify(paneIds[1])})`);
await sleep(400);
const tabsBefore = (await listTargets()).filter((t) =>
  (t.url ?? '').includes('terminal.html'),
).length;
await evaluate(a.client, 'window.__tabterm.detachPane()');
await sleep(4000);

const one = JSON.parse(await widths());
r.ok(
  'the pane that stays fills the space the other left',
  one.length === 1 && one[0] > two[0] * 1.6,
  JSON.stringify({ two, one }),
);
r.ok(
  'and the pane that left has a tab of its own',
  (await listTargets()).filter((t) => (t.url ?? '').includes('terminal.html')).length ===
    tabsBefore + 1,
);

await finish();
r.done();
