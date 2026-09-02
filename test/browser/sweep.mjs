// End anything the suites left running.
//
// Each suite ends its own sessions, but one that reloads its page loses the connection that
// would do it, and one that closes its tab never gets the chance. Sessions outlive the daemon
// now, so what used to be tidied up by the next restart is a shell running until somebody looks.
import { connect, listTargets } from './cdp.mjs';

/**
 * Nothing here waits forever.
 *
 * A tab that has stopped answering never resolves its CDP call, and this loop had no timeout, so
 * one dead tab held the whole run open. It ran for six minutes after suites that had finished in
 * forty seconds, which looked exactly like the suites being slow.
 */
const within = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

const targets = await within(listTargets(), 5000, []);
const pages = targets.filter((t) => t.url.includes('terminal.html'));
let ended = 0;

// All of them at once, each with its own short deadline. They are independent, and doing them
// one after another meant the slowest tab set the pace for every other.
const counts = await Promise.all(
  pages.map((page) =>
    within(
      (async () => {
        try {
          const client = await connect(page.webSocketDebuggerUrl);
          await client.ready;
          await client.send('Runtime.enable');
          const before = await client.send('Runtime.evaluate', {
            expression: `window.__tabterm?.paneIds().length ?? 0`,
            returnByValue: true,
          });
          await client.send('Runtime.evaluate', {
            expression: `window.__tabterm?.endSessions?.()`,
            returnByValue: true,
          });
          return Number(before.result?.value ?? 0);
        } catch {
          // A tab that has already gone has nothing left to end.
          return 0;
        }
      })(),
      4000,
      0,
    ),
  ),
);
ended += counts.reduce((a, b) => a + b, 0);

/**
 * Sessions no tab is holding any more.
 *
 * The loop above can only reach a session through the tab showing it, so one whose tab was
 * closed, crashed, or reloaded away survives every sweep. They accumulate, and because a stale
 * one is still reported as open in a tab it sorts to the top of the list an empty pane offers,
 * pushing the session a suite actually opened off the end of it.
 *
 * **Off by default, and hard-bounded when on.** It opens a page and drives the start screen,
 * which is a slow thing to do at the end of every run; left on and unbounded it took six minutes
 * on its own, which was longer than every suite put together. Run it deliberately with
 * `TT_SWEEP_ORPHANS=1` when the lists start looking crowded.
 */
if (process.env['TT_SWEEP_ORPHANS'] === '1') {
  const { openTerminal, evaluate, sleep, finish } = await import('./helpers.mjs');
  const deadline = new Promise((resolve) => setTimeout(() => resolve('timed out'), 30_000));
  const work = (async () => {
    const own = await openTerminal();
    const orphans = Number(
      await evaluate(
        own.client,
        `(() => {
          let n = 0;
          for (const card of document.querySelectorAll('.session-card')) {
            const close = card.querySelector('.session-close');
            if (close) { close.click(); n++; }
          }
          return n;
        })()`,
      ),
    );
    await sleep(600);
    ended += orphans;
    await finish();
    return 'done';
  })();
  const outcome = await Promise.race([work, deadline]);
  if (outcome === 'timed out') console.log('  orphan sweep gave up after 30s');
}

if (ended > 0) console.log(`  swept ${String(ended)} session(s) the suites left behind`);
