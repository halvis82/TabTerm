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
  /**
   * Written from a context that actually has `chrome.storage`.
   *
   * This used to take the first extension page it could find and fall back to *any* page, which
   * straight after loading an unpacked extension is `about:blank`. There is no `chrome` there,
   * so the expression threw, nothing checked for the exception, and it printed that it had
   * pointed the browser at the test daemon. It had not. Every suite then ran against the daemon
   * on 7377, which is the one somebody is working in, and the temporary home and the separate
   * port were both for nothing.
   *
   * The service worker is the context to use: it exists as soon as the extension is loaded and
   * it has the whole API surface.
   */
  const wanted = `chrome-extension://${result.id}`;
  let host = null;
  for (let attempt = 0; attempt < 40 && !host; attempt++) {
    const targets = await listTargets();
    host =
      targets.find((t) => t.type === 'service_worker' && t.url?.startsWith(wanted)) ??
      targets.find((t) => t.type === 'page' && t.url?.startsWith(wanted)) ??
      null;
    if (!host) await new Promise((r) => setTimeout(r, 250));
  }
  if (!host?.webSocketDebuggerUrl) {
    console.error('no extension context to write the daemon port into');
    process.exit(1);
  }

  const c = connect(host.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Runtime.enable');
  const written = await c.send('Runtime.evaluate', {
    expression: `chrome.storage.local.set({ 'tabterm.port': ${Number(port)} })
      .then(() => chrome.storage.session.set({ 'tabterm.token': ${JSON.stringify(token)} }))
      .then(() => chrome.storage.local.get('tabterm.port'))
      .then((s) => String(s['tabterm.port']))`,
    awaitPromise: true,
    returnByValue: true,
  });
  // Checked, rather than assumed. Assuming it is what let this fail silently for weeks.
  if (written.exceptionDetails || String(written.result?.value) !== String(Number(port))) {
    console.error(
      `could not point the browser at ${port}: ${
        written.exceptionDetails?.exception?.description ?? String(written.result?.value)
      }`,
    );
    process.exit(1);
  }
  console.log(`  pointed at the test daemon on ${port}`);
}
process.exit(0);
