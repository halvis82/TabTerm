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

if (ended > 0) console.log(`  swept ${String(ended)} session(s) the suites left behind`);
