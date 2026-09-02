// Load the built extension into the running headless Chrome.
//
// Chrome removed --load-extension, so this goes through the debugging protocol instead. It
// prints the assigned id, which must match the one in package.json: a mismatch means the
// manifest key changed, and every stable tab URL with it.
import { connect, listTargets } from './cdp.mjs';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).tabterm
  .extensionId;

const browser = (await listTargets()).find((t) => t.type === 'page') ?? null;
if (!browser) {
  console.error('no page target; is headless Chrome running?');
  process.exit(1);
}

const response = await fetch(`http://127.0.0.1:${process.env.TT_CDP_PORT ?? '9223'}/json/version`);
const { webSocketDebuggerUrl } = await response.json();
const client = connect(webSocketDebuggerUrl);
await client.ready;

const result = await client.send('Extensions.loadUnpacked', {
  path: new URL('extension/dist', root).pathname,
});
console.log(`extension: ${result.id}`);
if (result.id !== expected) {
  console.error(`  WARNING: expected ${expected}. Stable tab URLs depend on this id.`);
}

/**
 * Point this browser at the suites' own daemon, and give it that daemon's token.
 *
 * Without both, the extension finds the daemon a person is working in. That is how a sweep in
 * the harness came to end a real terminal: it was not reaching across a boundary, there was no
 * boundary. `TT_DAEMON_PORT` and `TT_DAEMON_TOKEN` are set by `run.mjs`, which starts a daemon
 * with its own `TABTERM_HOME`.
 *
 * The token is normally fetched over native messaging from the installed host, which knows only
 * about the real daemon, so it is seeded directly into the session storage that fetch caches to.
 */
const port = process.env.TT_DAEMON_PORT;
const token = process.env.TT_DAEMON_TOKEN;
if (port && token) {
  const page = (await listTargets()).find((t) =>
    t.url?.startsWith(`chrome-extension://${result.id}`),
  );
  const target = page ?? (await listTargets()).find((t) => t.type === 'page');
  if (target?.webSocketDebuggerUrl) {
    const c = connect(target.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Runtime.enable');
    await c.send('Runtime.evaluate', {
      expression: `chrome.storage.local.set({ 'tabterm.port': ${Number(port)} }).then(() =>
        chrome.storage.session.set({ 'tabterm.token': ${JSON.stringify(token)} }))`,
      awaitPromise: true,
    });
    console.log(`  pointed at the test daemon on ${port}`);
  }
}
process.exit(0);
