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
 * There is deliberately no sweep of sessions no tab is holding.
 *
 * There was one, and **it ended Halvor's real terminals.** It opened a start screen and pressed
 * the close control on every session card, and that list is every session the daemon holds: the
 * suites and the browser they run in are separate, but the daemon is the one he is working in.
 * A session of his that had run `ls` nineteen seconds earlier was ended by a test run.
 *
 * It cannot be made safe by being careful, because nothing on that screen distinguishes a
 * session a suite created from one a person is using. So it is gone. Suites end what they
 * created, through the tabs they opened, and a session that outlives its tab is left alone until
 * the daemon's own policy decides about it.
 *
 * Nothing in this repository may end a session it did not create.
 */

if (ended > 0) console.log(`  swept ${String(ended)} session(s) the suites left behind`);
