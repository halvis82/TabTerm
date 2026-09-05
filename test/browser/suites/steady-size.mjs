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
await sleep(5000);
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

await finish();
r.done();
