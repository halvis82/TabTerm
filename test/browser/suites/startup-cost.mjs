// Where the time goes when a tab opens, measured rather than guessed.
//
// Asked for as "i want everything sped up and more efficient if you can find ways to do that".
// The first thing that needs is a number: what a tab actually spends before it is usable, and
// how many messages it takes to get there. Budgets are deliberately generous. This is here to
// catch something getting much worse, and to make an improvement provable.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

/** Count what the page sends, from as early as a script can run. */
const INSTRUMENT = `(() => {
  window.__wire = { sent: 0, received: 0, kinds: {} };
  const OrigWS = window.WebSocket;
  if (!OrigWS.__counted) {
    const Counted = function (...args) {
      const ws = new OrigWS(...args);
      const send = ws.send.bind(ws);
      ws.send = (data) => { window.__wire.sent += 1; return send(data); };
      ws.addEventListener('message', () => { window.__wire.received += 1; });
      return ws;
    };
    Counted.prototype = OrigWS.prototype;
    Counted.__counted = true;
    window.WebSocket = Counted;
  }
})()`;

/** A tab that has never been used: how long until its start screen is usable. */
{
  const a = await openTerminal();
  await waitFor(a.client, "document.querySelector('.launcher-input')");
  await sleep(2000);
  await evaluate(a.client, INSTRUMENT);
  await evaluate(a.client, 'location.reload()');
  await sleep(150);
  await evaluate(a.client, INSTRUMENT);
  await waitFor(a.client, `!document.querySelector('.launcher')?.hidden`, 20000);

  const timing = JSON.parse(
    await evaluate(
      a.client,
      `(() => { const nav = performance.getEntriesByType('navigation')[0];
         return JSON.stringify({
           usable: Math.round(performance.now()),
           domContentLoaded: Math.round(nav ? nav.domContentLoadedEventEnd : 0),
           scripts: performance.getEntriesByType('resource').filter(e => e.name.endsWith('.js')).length,
           transferred: Math.round(performance.getEntriesByType('resource')
             .reduce((sum, e) => sum + (e.transferSize || 0), 0) / 1024),
         }); })()`,
    ),
  );
  // Measured at about 150 ms when this was written, on an ordinary laptop under a full run.
  r.ok(
    'a start screen is usable well inside two seconds',
    timing.usable < 2000,
    JSON.stringify(timing),
  );
  r.ok(
    'and the page it loads is not enormous',
    timing.transferred < 6000,
    `${String(timing.transferred)} KB over ${String(timing.scripts)} scripts`,
  );
}

/** A tab with work in it: how long until its own screen is back. */
{
  const b = await openTerminal();
  await waitFor(b.client, "document.querySelector('.launcher-input')");
  await type(b.client, 'echo STARTUP-COST');
  await sleep(2000);
  await evaluate(b.client, 'location.reload()');
  await sleep(150);
  await waitFor(b.client, `(window.__tabterm?.readScreen() ?? '').includes('STARTUP-COST')`, 20000);
  const back = Number(await evaluate(b.client, 'Math.round(performance.now())'));
  r.ok(
    'a tab with work is back on its own screen inside three seconds',
    back < 3000,
    `${String(back)}ms`,
  );
}

/** And an idle tab, once settled, says nothing at all. */
{
  const c = await openTerminal();
  await waitFor(c.client, "document.querySelector('.launcher-input')");
  await sleep(1500);
  await evaluate(c.client, INSTRUMENT);
  await evaluate(c.client, `(() => { window.__wire.sent = 0; window.__wire.received = 0; })()`);
  await sleep(5000);
  const idle = JSON.parse(await evaluate(c.client, 'JSON.stringify(window.__wire)'));
  r.ok(
    'an idle start screen sends almost nothing over five seconds',
    idle.sent <= 3,
    JSON.stringify(idle),
  );
}

/**
 * How much work one change to the start screen costs.
 *
 * The daemon now says "the answer changed" whenever it does, and the page asks for the three
 * things the start screen draws. Each answer used to redraw the whole screen, so one change cost
 * three full rebuilds of a list of cards. This measures the redraws rather than the milliseconds,
 * because the count is the thing that was wrong and the milliseconds depend on the machine.
 */
{
  const d = await openTerminal();
  await waitFor(d.client, "document.querySelector('.launcher-input')");
  await sleep(2000);

  /**
   * Zeroed once this tab has gone quiet.
   *
   * Its own startup draws too, and the project files it asks about arrive a moment after that.
   * What is being counted is the cost of a change somewhere else, so the count starts when this
   * tab has finished being born.
   */
  await sleep(1500);
  const drawnBefore = JSON.parse(
    await evaluate(d.client, 'JSON.stringify(window.__tabterm.renderLog())'),
  ).length;

  // One change, made the way anything makes one: a command finishing in another tab.
  const other = await openTerminal();
  await waitFor(other.client, "document.querySelector('.launcher-input')");
  await type(other.client, 'echo REDRAW-COST');
  await sleep(3000);

  /**
   * Counted from the launcher's own record rather than from DOM mutations.
   *
   * One `replaceChildren` produces separate records for what it removed and what it added, so
   * counting mutations counted every drawing twice and made a fixed thing look half fixed.
   */
  const log = JSON.parse(await evaluate(d.client, 'JSON.stringify(window.__tabterm.renderLog())'));
  const redraws = log.length - drawnBefore;
  /**
   * Nine before this was coalesced, one after.
   *
   * The three answers to a single change arrive in three messages a few milliseconds apart, and
   * each of them redrew the whole screen. The count is what was wrong; the milliseconds depend
   * on the machine and say less.
   */
  /**
   * Nine before the answers were named, one after.
   *
   * The start screen is made of six things that arrive in six messages, a round trip apart, and
   * each of them used to redraw the whole screen. Gathering them on a timer could not fix that,
   * because a timer cannot know how many are still coming: it measured three. The screen is told
   * what it asked for and draws once it has it.
   *
   * The detail is what prompted each drawing, so a regression names its own cause.
   */
  r.ok(
    'one change to the start screen costs one drawing, not one per answer',
    redraws >= 0 && redraws <= 1,
    `${String(redraws)} :: ${JSON.stringify(log.slice(drawnBefore))}`,
  );
}

await finish();
r.done();
