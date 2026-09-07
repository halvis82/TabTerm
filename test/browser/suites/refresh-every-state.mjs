// Refreshing a tab puts it back where it was, and never shows another screen on the way.
//
// Asked for as "make sure that when refreshing it goes straight to the correct page for
// everything". Two states were already covered; a tab can be in more than two. Each case here
// samples what is on screen from the first moment the page can run anything, because by the time
// a tab has settled the answer is right and a flash is invisible.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  type,
  openPaneMenu,
  realClick,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

/** Watch what is on screen: the start screen, a terminal, or neither. */
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

/**
 * Refresh a tab and report what it showed on the way and where it landed.
 *
 * The watcher is installed twice: once before the reload, which is lost with the page, and once
 * immediately after, which is the earliest a script can run in the new document.
 */
const refreshAndWatch = async (client, settled, timeout = 20000) => {
  await evaluate(client, WATCH);
  await evaluate(client, 'location.reload()');
  await sleep(250);
  await evaluate(client, WATCH);
  const ok = await waitFor(client, settled, timeout);
  await sleep(500);
  await evaluate(client, 'clearInterval(window.__seenTimer)');
  const seen = JSON.parse(await evaluate(client, 'JSON.stringify(window.__seen)'));
  return { ok, seen, states: seen.map((s) => s.state) };
};

/** A tab that has never been used. */
{
  const a = await openTerminal();
  await waitFor(a.client, "document.querySelector('.launcher-input')");
  await sleep(1200);
  const out = await refreshAndWatch(a.client, `!document.querySelector('.launcher')?.hidden`);
  r.ok('an unused tab comes back to its start screen', out.ok, JSON.stringify(out.seen));
  r.ok(
    '  without showing a terminal first',
    !out.states.includes('terminal'),
    JSON.stringify(out.states),
  );
}

/** A tab with one pane that has run something. */
{
  const b = await openTerminal();
  await waitFor(b.client, "document.querySelector('.launcher-input')");
  await type(b.client, 'echo REFRESH-ONE-PANE');
  await sleep(2000);
  const out = await refreshAndWatch(
    b.client,
    `(window.__tabterm?.readScreen() ?? '').includes('REFRESH-ONE-PANE')`,
  );
  r.ok('a tab with work comes back to its terminal', out.ok, JSON.stringify(out.seen));
  r.ok(
    '  without showing the start screen first',
    !out.states.includes('start-screen'),
    JSON.stringify(out.states),
  );
}

/** A tab with several panes. */
{
  const c = await openTerminal();
  await waitFor(c.client, "document.querySelector('.pane')");
  await type(c.client, 'echo REFRESH-SPLIT');
  await sleep(1800);
  await openPaneMenu(c.client, 80, 120);
  await realClick(c.client, '.term-menu-item', 'Split right');
  await waitFor(c.client, `document.querySelectorAll('.pane').length === 2`, 12000);
  await evaluate(c.client, "document.querySelector('.term-menu')?.remove()");
  await sleep(1200);

  const out = await refreshAndWatch(
    c.client,
    `document.querySelectorAll('.pane').length === 2 &&
     (window.__tabterm?.readScreen() ?? '').includes('REFRESH-SPLIT')`,
    25000,
  );
  r.ok('a split comes back as a split', out.ok, JSON.stringify(out.seen));
  r.ok(
    '  without showing the start screen first',
    !out.states.includes('start-screen'),
    JSON.stringify(out.states),
  );
  const count = Number(await evaluate(c.client, `document.querySelectorAll('.pane').length`));
  r.ok('  with the same number of panes', count === 2, String(count));
}

/** A tab whose pane carries a name. */
{
  const d = await openTerminal();
  await waitFor(d.client, "document.querySelector('.pane')");
  await type(d.client, 'echo REFRESH-NAMED');
  await sleep(1800);
  await openPaneMenu(d.client, 80, 120);
  const named = await realClick(d.client, '.term-menu-item', 'Name session');
  if (named !== false) {
    await waitFor(d.client, `!!document.querySelector('.pane-label-form input')`, 8000);
    await evaluate(
      d.client,
      `(() => { const i = document.querySelector('.pane-label-form input');
         i.value = 'REFRESH-LABEL'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    // Saved with the button. Typing only previews it, in this tab: nothing is sent until Save,
    // so an abandoned form leaves no trace and Escape genuinely cancels.
    await realClick(d.client, '.pane-label-form .term-menu-item', 'Save');
    await sleep(1200);
    const before = await evaluate(
      d.client,
      `[...document.querySelectorAll('.pane-label')].some(e => (e.textContent || '').includes('REFRESH-LABEL')) ? 'yes' : 'no'`,
    );
    r.ok('the pane takes the name in the first place', String(before) === 'yes');
    const out = await refreshAndWatch(
      d.client,
      `[...document.querySelectorAll('.pane-label')].some(e => (e.textContent || '').includes('REFRESH-LABEL'))`,
      25000,
    );
    r.ok('a named pane comes back with its name', out.ok, JSON.stringify(out.seen));
    r.ok(
      '  without showing the start screen first',
      !out.states.includes('start-screen'),
      JSON.stringify(out.states),
    );
  } else {
    r.skip('a named pane comes back with its name', 'could not name it');
  }
  await evaluate(d.client, "document.querySelector('.term-menu')?.remove()");
}

/** A tab with the command menu open. It is a panel, not a page: a refresh may close it. */
{
  const e = await openTerminal();
  await waitFor(e.client, "document.querySelector('.launcher-input')");
  await type(e.client, 'echo REFRESH-PANEL');
  await sleep(1800);
  await evaluate(e.client, `document.getElementById('cmd-button')?.click()`);
  await waitFor(e.client, `!document.querySelector('.cmd-panel')?.hidden`, 8000);
  const out = await refreshAndWatch(
    e.client,
    `(window.__tabterm?.readScreen() ?? '').includes('REFRESH-PANEL')`,
  );
  r.ok('a tab with the menu open comes back to its terminal', out.ok, JSON.stringify(out.seen));
  r.ok(
    '  without showing the start screen first',
    !out.states.includes('start-screen'),
    JSON.stringify(out.states),
  );
}

/**
 * And a refreshed terminal looks like the thing holding the keyboard.
 *
 * Typing reached the shell without this, because a keystroke with nowhere better to go is handed
 * to the focused pane. The cursor was the problem: a terminal nothing has focused draws a hollow
 * one, so every refresh left the screen saying the keyboard was somewhere else.
 */
{
  const f = await openTerminal();
  await waitFor(f.client, "document.querySelector('.launcher-input')");
  await type(f.client, 'echo REFRESH-FOCUS');
  await sleep(2000);
  await evaluate(f.client, 'location.reload()');
  await waitFor(
    f.client,
    `(window.__tabterm?.readScreen() ?? '').includes('REFRESH-FOCUS')`,
    20000,
  );
  const focused = await waitFor(
    f.client,
    `!!document.querySelector('.xterm.focus, .terminal.focus')`,
    10000,
  );
  r.ok('a refreshed terminal looks like it has the keyboard', focused);

  // And really does have it: what is typed next reaches the shell with nothing clicked first.
  const MARK = `AFTER-REFRESH-${String(Date.now()).slice(-5)}`;
  await type(f.client, `echo ${MARK}`);
  const landed = await waitFor(
    f.client,
    `(window.__tabterm.readScreen() ?? '').includes(${JSON.stringify(MARK)})`,
    12000,
  );
  r.ok('and what is typed next reaches the shell', landed);
}

await finish();
r.done();
