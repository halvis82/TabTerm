// Progress a program reports, OSC 9;4, shown in the tab: a ring filled that far, and the
// percentage in the title. Asked for from the list of ideas: "progress in the tab icon".
import { openTerminal, evaluate, type, finish, waitFor, waitUntil, sleep } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo ready\r');
await sleep(1500);
const title = () => evaluate(client, 'document.title').then(String);
const icon = () => evaluate(client, "document.getElementById('favicon')?.href ?? ''").then(String);

// A program at 25 percent, and still running.
await type(client, `printf '\\033]9;4;1;25\\a'; sleep 4\r`);
r.ok(
  'the title says how far along it is',
  await waitUntil(async () => / · 25%$/.test(await title()), 5000),
  await title(),
);
const at25 = await icon();
if (process.env.TT_SHOT_DIR)
  (await import('node:fs')).writeFileSync(
    `${process.env.TT_SHOT_DIR}/progress-icon.png`,
    Buffer.from(at25.split(',')[1] ?? '', 'base64'),
  );
await sleep(500);
const later = await icon();
r.ok(
  'and the icon is a ring filled that far, holding still rather than turning',
  at25.startsWith('data:image/png') && later === at25,
);

// Done: the command ends, and so does the progress, whether or not the program said so.
r.ok(
  'and it goes when the command ends',
  await waitUntil(async () => !/%/.test(await title()), 10000),
  await title(),
);
r.ok('and the icon is no longer the progress ring', (await icon()) !== at25);

// An error, at 80 percent.
await type(client, `printf '\\033]9;4;2;80\\a'; sleep 3\r`);
r.ok(
  'an error says where it stopped',
  await waitUntil(async () => / · failed at 80%$/.test(await title()), 5000),
  await title(),
);
await waitUntil(async () => !/%/.test(await title()), 10000);

// Any other OSC 9 is not progress, and leaves the title alone.
await type(client, `printf '\\033]9;build finished\\a'; sleep 2\r`);
await sleep(800);
r.ok(
  'a notification sent as OSC 9 is not taken for progress',
  !/%/.test(await title()),
  await title(),
);
await finish();
r.done();
