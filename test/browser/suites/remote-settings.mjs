// Remote access, as somebody sets it up in Settings: off at first, a relay entered, turned on,
// connected, and a pairing code shown. The relay is the real relay code, run by this suite.
import { randomBytes } from 'node:crypto';
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
import { startRelay } from '../../remote/relay-shim.mjs';

const r = reporter();
const secret = randomBytes(24).toString('base64url');
const relay = await startRelay({ secret });
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

await evaluate(client, 'document.querySelector("#cmd-button")?.click()');
await sleep(500);
await evaluate(client, 'document.querySelector(".cmd-gear")?.click()');
const section = 'document.querySelector("[data-remote]")';
r.ok('Settings has a Remote access section', await waitFor(client, `${section} !== null`, 6000));
r.ok(
  'and it is off until somebody turns it on',
  await waitFor(
    client,
    `${section}?.querySelector('[data-remote-status]')?.dataset.remoteStatus === 'off'`,
    4000,
  ),
);

const fill = (selector, value) =>
  evaluate(
    client,
    `(() => { const el = ${section}.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input')); })()`,
  );
await fill('[data-remote-url]', relay.url);
await fill('[data-remote-secret]', secret);
await evaluate(
  client,
  `[...${section}.querySelectorAll('button')].find((b) => b.textContent === 'Save relay')?.click()`,
);
await sleep(400);
r.ok(
  'the secret is not shown again once saved',
  !String(await evaluate(client, `${section}?.innerHTML ?? ''`)).includes(secret),
);
r.ok(
  'and the box says one is saved',
  await waitFor(
    client,
    `${section}?.querySelector('[data-remote-secret]')?.placeholder.startsWith('Saved')`,
    4000,
  ),
);

await evaluate(
  client,
  `[...${section}.querySelectorAll('.set-toggle')].find((t) => t.textContent.startsWith('Remote access'))?.querySelector('input')?.click()`,
);
r.ok(
  'turned on, it connects to the relay',
  await waitFor(
    client,
    `${section}?.querySelector('[data-remote-status]')?.dataset.remoteStatus === 'connected'`,
    10000,
  ),
  String(await evaluate(client, `${section}?.querySelector('[data-remote-status]')?.textContent`)),
);

await evaluate(
  client,
  `[...${section}.querySelectorAll('button')].find((b) => b.textContent === 'Show a pairing code')?.click()`,
);
r.ok(
  'and shows a code to scan',
  await waitFor(
    client,
    `${section}?.querySelector('[data-remote-pairing] svg path')?.getAttribute('d').length > 100`,
    4000,
  ),
);
r.ok(
  'with a link that keeps its key in the fragment',
  /#pair=[\w-]+\.[\w-]+\.[\w-]{40,}$/.test(
    String(
      await evaluate(client, `${section}?.querySelector('.set-pairing-link')?.textContent ?? ''`),
    ),
  ),
);

// A picture of the section, for looking at by eye: TT_SHOT_DIR=<folder>.
if (process.env.TT_SHOT_DIR) {
  await evaluate(client, `${section}?.scrollIntoView({ block: 'start' })`);
  await sleep(300);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${process.env.TT_SHOT_DIR}/remote-settings.png`, Buffer.from(shot.data, 'base64'));
}

// Off again, which closes the connection.
await evaluate(
  client,
  `[...${section}.querySelectorAll('.set-toggle')].find((t) => t.textContent.startsWith('Remote access'))?.querySelector('input')?.click()`,
);
r.ok(
  'and turned off, it is off',
  await waitFor(
    client,
    `${section}?.querySelector('[data-remote-status]')?.dataset.remoteStatus === 'off'`,
    4000,
  ),
);

await relay.close();
await finish();
r.done();
