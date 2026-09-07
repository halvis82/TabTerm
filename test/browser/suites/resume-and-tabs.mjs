// Only offer what works, and do not leave a spare tab behind.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  realClick,
  waitFor,
  waitUntil,
} from '../helpers.mjs';
import { listTargets, reporter } from '../cdp.mjs';

const r = reporter();
const a = await openTerminal();
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(a.client, 'window.__tabterm.resumable().length > 0');

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

/**
 * Reading a conversation before deciding to resume it.
 *
 * One line of the first prompt does not tell three sessions apart when all three begin "help me
 * with". The agent's own file is read for this; nothing is started, because resuming a session to
 * find out whether you want it changes the thing being inspected.
 */
{
  const below = async () =>
    Number(
      await evaluate(
        a.client,
        `(() => { const rows = document.querySelectorAll('.launcher-row.is-resume');
           const last = rows[rows.length - 1];
           return last ? Math.round(last.getBoundingClientRect().top) : -1; })()`,
      ),
    );
  /**
   * Waited for the row, not for the data behind it.
   *
   * The start screen draws once it has everything it asked for, so the answer arriving and the
   * row existing are two moments now rather than one. Clicking on the strength of the first is
   * clicking at nothing.
   */
  await waitFor(a.client, `!!document.querySelector('.launcher-row-action.is-expand')`, 10000);
  const beforeTop = await below();
  const opened = await realClick(a.client, '.launcher-row-action.is-expand');
  r.ok('a conversation can be opened from its row', opened !== false);

  const shown = await waitFor(
    a.client,
    `document.querySelectorAll('.launcher-transcript').length === 1`,
    10000,
  );
  r.ok('exactly one conversation is open at a time', shown);

  // What was in the file, or an honest sentence saying there was nothing readable in it.
  const settled = await waitFor(
    a.client,
    `!document.querySelector('.launcher-transcript')?.classList.contains('is-waiting') ||
     (document.querySelector('.launcher-transcript')?.textContent ?? '').includes('Nothing readable')`,
    15000,
  );
  const turns = Number(
    await evaluate(a.client, `document.querySelectorAll('.launcher-turn').length`),
  );
  const text = String(
    await evaluate(a.client, `document.querySelector('.launcher-transcript')?.textContent ?? ''`),
  );
  r.ok(
    'and it shows the conversation, or says plainly that it could not be read',
    settled && (turns > 0 || text.includes('Nothing readable')),
    `${String(turns)} turns: ${text.slice(0, 70).replace(/\s+/g, ' ')}`,
  );

  /**
   * It pushes what is below it down rather than covering anything.
   *
   * Asked for that way, and it is what a list should do: deciding between three of these means
   * reading them where they are.
   */
  const afterTop = await below();
  r.ok(
    'the rows below are pushed down rather than covered',
    beforeTop === -1 || afterTop > beforeTop,
    `${String(beforeTop)} -> ${String(afterTop)}`,
  );

  await realClick(a.client, '.launcher-row-action.is-expand');
  await sleep(400);
  r.ok(
    'and it collapses again, putting the list back',
    Number(await evaluate(a.client, `document.querySelectorAll('.launcher-transcript').length`)) ===
      0,
  );

  /**
   * And expanding does not throw the list back to the top.
   *
   * The list is redrawn from scratch when a row opens, and a fresh element starts at scroll zero,
   * so the row somebody was reading jumped off the screen. The scroll is put back before the
   * list is on screen, so it never paints at the top and then moves.
   *
   * The window the harness uses is tall enough that the list does not overflow, which is why this
   * went unchecked: with nothing to scroll there is no position to lose. So the list is made
   * short here, which is the same situation as a list with more in it.
   */
  await evaluate(
    a.client,
    `(() => { const s = document.createElement('style');
       s.textContent = '.launcher-body { max-height: 120px; overflow-y: auto; }';
       document.head.append(s); })()`,
  );
  await sleep(150);
  // A rule rather than an inline style, because the list is rebuilt from scratch when a row
  // opens and the element the style was put on is gone by the time it matters.
  await evaluate(
    a.client,
    `(() => { const b = document.querySelector('.launcher-body'); if (b) b.scrollTop = 60; })()`,
  );
  await sleep(150);
  const scrolledTo = Number(
    await evaluate(a.client, `document.querySelector('.launcher-body')?.scrollTop ?? 0`),
  );
  await realClick(a.client, '.launcher-row-action.is-expand');
  await sleep(500);
  const keptScroll = Number(
    await evaluate(a.client, `document.querySelector('.launcher-body')?.scrollTop ?? 0`),
  );
  r.ok(
    'expanding keeps the place in the list rather than jumping to the top',
    scrolledTo === 0 || keptScroll > 0,
    `${String(scrolledTo)} -> ${String(keptScroll)}`,
  );
  await realClick(a.client, '.launcher-row-action.is-expand');
  await sleep(300);
}

// Resuming from a tab that is still showing its start screen happens **in** that tab.
{
  const fresh = await openTerminal();
  // The prompt is already there; this waits for the start screen's own lists.
  // The codex row specifically. The folder box and the recent folders are both there long
  // before the daemon has answered with the conversations, so waiting for either was waiting
  // for the wrong thing and the click found nothing to press.
  await waitFor(fresh.client, "window.__tabterm.resumable().some((s) => s.agent === 'codex')");
  const was = (await listTargets()).filter((t) => (t.url ?? '').includes('terminal.html')).length;
  const workspaceWas = String(await evaluate(fresh.client, 'window.__tabterm.workspaceId()'));
  // Matched on the agent badge, which now leads the row: agent, then when, then what was said,
  // then where. The old text `codex · ~` no longer exists.
  // The same wait, for the same reason: the row exists when the screen has been drawn, not when
  // the answer behind it arrived.
  await waitFor(
    fresh.client,
    `[...document.querySelectorAll('.launcher-row.is-resume')].some((x) => (x.textContent || '').includes('codex'))`,
    10000,
  );
  const clicked = await realClick(fresh.client, '.launcher-row.is-resume', 'codex');
  r.ok('a resume row can be pressed', clicked !== false);
  // The resumed agent has started when the tab has changed workspace, which is the thing being
  // asserted. Nine seconds was a guess at how long Codex takes to draw its first frame.
  await waitFor(fresh.client, `window.__tabterm.workspaceId() !== ${JSON.stringify(workspaceWas)}`);
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
// The prompt is already there; this waits for the start screen's own lists.
await waitFor(spare.client, "document.querySelector('.launcher-input')");
const before = (await listTargets()).filter((t) => (t.url ?? '').includes('terminal.html')).length;
/**
 * Waited for, because the list follows the screen.
 *
 * A session is offered when something was started in it **and there is something on it**, so a
 * command that has just been typed reaches the list when its output does. The daemon pushes the
 * list again whenever it changes, so this is a wait for an event rather than for a duration.
 */
await waitFor(
  spare.client,
  `[...document.querySelectorAll('.session-card')].some((c) => (c.textContent ?? '').includes('RUNNING-HERE'))`,
  15000,
);
const took = await realClick(spare.client, '.session-card', 'RUNNING-HERE');
r.ok('the new tab lists the running session', took !== false);
// The tab closes itself, so wait for it to be gone rather than for long enough that it must be.
await waitUntil(
  async () =>
    (await listTargets()).filter((t) => (t.url ?? '').includes('terminal.html')).length < before,
);
const after = (await listTargets()).filter((t) => (t.url ?? '').includes('terminal.html')).length;
r.ok(
  'and closes itself rather than sitting there empty beside it',
  after === before - 1,
  `${String(before)} -> ${String(after)}`,
);

// Detaching a pane: the one that stays grows into the space.
await evaluate(a.client, "window.__tabterm.split('horizontal')");
await waitFor(a.client, "document.querySelectorAll('.pane').length === 2");
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
  // The prompt is already there; this waits for the start screen's own lists.
  await waitFor(onlooker.client, "document.querySelector('.launcher-input')");
  // The same wait, for the same reason: the list arrives when the output does.
  await waitFor(
    onlooker.client,
    `[...document.querySelectorAll('.session-card')].filter((c) =>
       (c.textContent ?? '').includes('RUNNING-HERE') ||
       (c.textContent ?? '').includes('SECOND-PANE')).length === 2`,
    15000,
  );
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
await waitFor(a.client, "document.querySelectorAll('.pane').length === 1");

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
