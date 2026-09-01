// End anything the suites left running.
//
// Each suite ends its own sessions, but one that reloads its page loses the connection that
// would do it, and one that closes its tab never gets the chance. Sessions outlive the daemon
// now, so what used to be tidied up by the next restart is a shell running until somebody looks.
import { connect, listTargets } from './cdp.mjs';

const targets = await listTargets();
const pages = targets.filter((t) => t.url.includes('terminal.html'));
let ended = 0;

for (const page of pages) {
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
    ended += Number(before.result?.value ?? 0);
  } catch {
    // A tab that has already gone has nothing left to end.
  }
}

/**
 * Sessions no tab is holding any more.
 *
 * The loop above can only reach a session through the tab showing it, so one whose tab was
 * closed, crashed, or reloaded away survives every sweep and lives until somebody looks. They
 * accumulate, and because a stale one is still reported as open in a tab it sorts to the top of
 * the list an empty pane offers, pushing the session a suite actually opened off the end of it.
 * That looked exactly like a broken chooser and cost a while to tell apart.
 *
 * So: open one page, and end everything it can see from the start screen.
 */
if (process.env['TT_SWEEP_ORPHANS'] !== '0') {
  const { openTerminal, evaluate, sleep, finish } = await import('./helpers.mjs');
  try {
    const own = await openTerminal();
    await sleep(4500);
    const orphans = Number(
      await evaluate(
        own.client,
        `(() => {
          const mine = new Set((window.__tabterm?.paneIds() ?? []).map((p) => p));
          const cards = [...document.querySelectorAll('.session-card')];
          let n = 0;
          for (const card of cards) {
            const close = card.querySelector('.session-close');
            if (close) { close.click(); n++; }
          }
          return n;
        })()`,
      ),
    );
    await sleep(800);
    ended += orphans;
    await finish();
  } catch {
    // No browser, or no start screen. Sweeping is best effort by definition.
  }
}

if (ended > 0) console.log(`  swept ${String(ended)} session(s) the suites left behind`);
