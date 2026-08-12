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
process.exit(0);
