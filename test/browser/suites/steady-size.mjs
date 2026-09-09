// A terminal that nobody is touching does not change size.
//
// This is the check that was missing when tabs began flickering several times a second. The
// cause was three faults compounding: an attach handed the daemon a placeholder size, the daemon
// told every view about it, and each view turned being told into asking, which the daemon
// answered. Ninety-five size changes in two seconds, which is a terminal that visibly flickers
// and a page that feels laggy because it is relaying out constantly.
//
// It is checked by counting, because a size that settles and a size that oscillates look the
// same in any single sample.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo STEADY\r');
await sleep(2000);

/** Every distinct size this pane takes, sampled far faster than a flicker. */
const watch = async (seconds) => {
  await evaluate(
    client,
    `(() => {
       window.__sizes = [];
       const seen = () => {
         const g = window.__tabterm.geometry();
         const last = window.__sizes[window.__sizes.length - 1];
         if (!g) return;
         if (!last || last.cols !== g.cols || last.rows !== g.rows) {
           window.__sizes.push({ cols: g.cols, rows: g.rows });
         }
       };
       clearInterval(window.__sizeTimer);
       window.__sizeTimer = setInterval(seen, 20);
       seen();
       return 'watching';
     })()`,
  );
  await sleep(seconds * 1000);
  await evaluate(client, 'clearInterval(window.__sizeTimer)');
  return JSON.parse(await evaluate(client, 'JSON.stringify(window.__sizes)'));
};

const idle = await watch(4);
r.ok(
  'a settled terminal keeps one size for four seconds',
  idle.length === 1,
  JSON.stringify(idle.slice(0, 8)),
);

// And through a reattach, which is where the placeholder used to arrive.
await evaluate(client, 'location.reload()');
// The wait below is the wait. Five seconds in front of it was five seconds of every run spent
// waiting for something that had usually already happened.
await waitFor(client, `(window.__tabterm?.readScreen() ?? '').includes('STEADY')`, 25000);
const afterReload = await watch(4);
r.ok(
  'and settles to one size after a reload rather than hunting for it',
  afterReload.length === 1,
  JSON.stringify(afterReload.slice(0, 8)),
);

// And with two panes, where each has its own measurement to disagree about.
await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, 'window.__tabterm.paneIds().length === 2', 30000);
await sleep(2500);
const split = await watch(4);
r.ok(
  'and stays still with a second pane beside it',
  split.length === 1,
  JSON.stringify(split.slice(0, 8)),
);

/**
 * And a tab still showing its start screen, which is where this was worst.
 *
 * The strip makes that terminal two rows tall, so its size is unusual and every path that
 * guesses a size guesses something far away from it. On the machine it was reported from, a
 * start screen tab was changing between two rows and eighty by twenty-four thousands of times a
 * second.
 */
{
  const fresh = await openTerminal();
  await waitFor(fresh.client, "document.querySelector('.launcher-input')");
  await sleep(2500);
  await evaluate(
    fresh.client,
    `(() => {
       window.__sizes = [];
       const seen = () => {
         const g = window.__tabterm.geometry();
         const last = window.__sizes[window.__sizes.length - 1];
         if (!g) return;
         if (!last || last.cols !== g.cols || last.rows !== g.rows) {
           window.__sizes.push({ cols: g.cols, rows: g.rows });
         }
       };
       clearInterval(window.__sizeTimer);
       window.__sizeTimer = setInterval(seen, 20);
       seen();
       return 'watching';
     })()`,
  );
  await sleep(4000);
  await evaluate(fresh.client, 'clearInterval(window.__sizeTimer)');
  const strip = JSON.parse(await evaluate(fresh.client, 'JSON.stringify(window.__sizes)'));
  r.ok(
    'a tab showing its start screen keeps one size too',
    strip.length === 1,
    JSON.stringify(strip.slice(0, 8)),
  );

  /**
   * And it keeps one size while a command is printing into it.
   *
   * This is the case it was worst in. The box under the start screen grows to fit the line being
   * typed, and the prompt's width is learned from where the cursor sits when the line is empty.
   * While a command runs the cursor is wherever the output put it, so the arithmetic asked for a
   * second row, the next chunk moved the cursor back, and the box grew and shrank on every chunk
   * of output. Output is not an instruction to resize anything.
   */
  await evaluate(
    fresh.client,
    `(() => { window.__sizes = []; clearInterval(window.__sizeTimer);
       window.__sizeTimer = setInterval(() => {
         const g = window.__tabterm.geometry();
         const last = window.__sizes[window.__sizes.length - 1];
         if (!g) return;
         if (!last || last.cols !== g.cols || last.rows !== g.rows) {
           window.__sizes.push({ cols: g.cols, rows: g.rows });
         }
       }, 20);
       return 'watching'; })()`,
  );
  // Typed without submitting, so the start screen is still up while output arrives from a
  // command started in another way.
  await evaluate(
    fresh.client,
    `(() => { const id = window.__tabterm.paneIds()[0];
       window.__tabterm.writeToPane(id, 'x'.repeat(400));
       return 'ok'; })()`,
  );
  await sleep(3000);
  await evaluate(fresh.client, 'clearInterval(window.__sizeTimer)');
  const printing = JSON.parse(await evaluate(fresh.client, 'JSON.stringify(window.__sizes)'));
  r.ok(
    'and while output is arriving into it',
    printing.length <= 1,
    JSON.stringify(printing.slice(0, 8)),
  );
}

/**
 * A tab back from a long absence repaints, and ends up the size it started.
 *
 * The nudge is a size taken down a row and put back, which is the one thing every terminal
 * application treats as "draw it all again". The risk it carries is obvious: a resize that does
 * not come back leaves every pane a row short, and a resize that does not settle is the flicker
 * this suite exists for. So it is done here, in the suite that counts sizes, rather than
 * anywhere else.
 *
 * The absence itself is faked. Waiting a minute is the point of the threshold and no way to
 * spend a minute of a test run. When it fires is checked in `wake-redraw.test.ts`.
 */
{
  /**
   * Read from what the daemon applied, not from the grid on screen.
   *
   * The grid never moves: the page follows a size only when it is overruled, and a nudge is this
   * pane's own request, so the daemon agrees and there is nothing to follow. A first version of
   * this check watched the grid and passed with the whole restore deleted, which is a check that
   * cannot fail and therefore is not one.
   */
  const applied = async () =>
    JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.appliedSizes())'));
  /**
   * Read from what the daemon last applied, not from the grid on screen.
   *
   * They are two different numbers. The grid is what the emulator is currently drawing; the
   * nudge acts on what the pane measures, and those disagree for a moment whenever the box has
   * changed and the grid has not caught up. Comparing one against the other made this check
   * about that gap rather than about the nudge.
   */
  /**
   * Something on the screen first, so there is a picture to be wrong about, and only then a
   * baseline.
   *
   * Typing is itself a reason for the box to change size, since the strip grows to fit what is
   * being typed. Taking the baseline before that measured the typing rather than the waking.
   */
  await type(client, 'echo WOKEN-MARKER');
  await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('WOKEN-MARKER')`, 8000);
  await sleep(1200);

  const history = await applied();
  const at = history[history.length - 1] ?? '';
  const seenBefore = history.length;

  await evaluate(client, 'window.__tabterm.redrawAfterAway()');
  await sleep(1500);
  const after = (await applied()).slice(seenBefore);

  /**
   * A woken tab must not resize the terminal at all.
   *
   * It used to, deliberately: a row down and back, the trick a multiplexer uses on reattach to make
   * a program repaint. That is safe for a shell and ruinous for anything that redraws by moving the
   * cursor up over its own last frame, because the resize scrolls the buffer underneath it and
   * every frame after that lands a row out, overwriting the wrong lines and leaving the previous
   * frame's fragments behind. A Claude Code session came out unreadable that way: nine of these
   * over twenty-four minutes, against 21,881 cursor-up sequences and five erase-downs in its
   * output.
   *
   * The screen is asked of the daemon now, which holds it, and nothing reaches the program at all.
   */
  r.ok(
    'a woken tab does not resize the terminal',
    after.length === 0,
    `from ${at}: ${after.join(' ') || '(none, which is right)'}`,
  );
  r.ok(
    'and what was on the screen is still there afterwards',
    String(
      await evaluate(client, `(window.__tabterm.readScreen() ?? '').includes('WOKEN-MARKER')`),
    ) === 'true',
    'the marker survived the repaint',
  );

  const afterNudge = await watch(4);
  r.ok(
    'and it settles rather than hunting',
    afterNudge.length === 1,
    JSON.stringify(afterNudge.slice(0, 8)),
  );
}

/**
 * And with two views of one session, which is where competing sizes actually come from.
 *
 * One PTY has one size, so a second, smaller view makes the applied size smaller than this one
 * asked for. That is the moment two authorities exist: what this page measured, and what the
 * daemon decided. Every flicker this product has had was that pair taking turns.
 *
 * The size is expected to change **once**, to the smaller one, and then to hold. A second change
 * would mean this page had argued back.
 */
{
  const paneId = String(await evaluate(client, `window.__tabterm.paneIds()[0] ?? ''`));
  r.ok('a pane to look at from two places', paneId !== '');
  // Counted from here, because the log is everything this page has ever been told and the
  // question is only about what the second view caused.
  const before = JSON.parse(
    await evaluate(client, 'JSON.stringify(window.__tabterm.appliedSizes())'),
  ).length;
  await evaluate(client, `window.__tabterm.attachSecondView(${JSON.stringify(paneId)}, 60, 14)`);
  await sleep(3000);

  const settled = await watch(4);
  r.ok(
    'a session with two views of different sizes settles rather than arguing',
    settled.length === 1,
    JSON.stringify(settled.slice(0, 8)),
  );
  r.ok(
    'and settles on the smaller of the two, which is the only size correct for both',
    settled[0] !== undefined && settled[0].cols <= 60 && settled[0].rows <= 14,
    JSON.stringify(settled[0] ?? null),
  );

  /** And the daemon applied one size for it, not a run of them. */
  const since = JSON.parse(
    await evaluate(client, 'JSON.stringify(window.__tabterm.appliedSizes())'),
  ).slice(before);
  r.ok(
    'and the terminal was told one thing rather than a sequence of them',
    new Set(since).size <= 1,
    since.join(' ') || '(nothing, which is also one thing)',
  );
}

await finish();
r.done();
