// What somebody sees when they have the extension and nothing else.
//
// This is every new person's first run, and it is what a Chrome Web Store reviewer sees on a
// machine with no companion program. It used to say "TabTerm is not paired with the daemon yet"
// and stop there: no link, no next step, and no mention that companion software exists. The honest
// reading of that screen is that the extension is broken.
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
import { writeFileSync } from 'node:fs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

await evaluate(client, `window.__tabterm.showSetupNeeded()`);
await sleep(300);

const screen = JSON.parse(
  await evaluate(
    client,
    `JSON.stringify({
       shown: !document.getElementById('recovery')?.hidden,
       heading: document.getElementById('recovery-reason')?.textContent ?? '',
       body: document.getElementById('recovery-detail')?.textContent ?? '',
       link: document.querySelector('#recovery-actions a')?.getAttribute('href') ?? '',
       linkText: document.querySelector('#recovery-actions a')?.textContent ?? '',
     })`,
  ),
);

r.ok('the screen is shown at all', screen.shown, JSON.stringify(screen.shown));
r.ok(
  'it says companion software is needed rather than that something failed',
  /companion|macOS only/i.test(screen.heading),
  screen.heading,
);
r.ok(
  'it says how to get it, with the commands',
  screen.body.includes('git clone') && screen.body.includes('install.sh'),
  screen.body.slice(0, 90).replace(/\s+/g, ' '),
);
r.ok(
  'it offers somewhere to go',
  screen.link.startsWith('https://github.com/') && screen.linkText.length > 0,
  `${screen.linkText} -> ${screen.link}`,
);
r.ok(
  'and it does not claim the session expired, which is a different thing entirely',
  !screen.heading.toLowerCase().includes('expired'),
  screen.heading,
);

/**
 * And a picture of it, because this screen is read rather than parsed.
 *
 * Written beside the suite's other output. What the assertions above cannot check is whether it
 * looks like an explanation or like an error, and that is the whole point of it.
 */
const shot = await client.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/tabterm-first-run.png', Buffer.from(shot.data, 'base64'));

await finish();
r.done();
