// A problem the daemon found is said in Settings and in the corner of the tab, until it is read.
//
// Asked for as: if Full Disk Access or something crucial is missing, check for it live and say
// so in Settings or as a dismissable notice. Driven with a fixture the test daemon believes,
// since a test cannot take a Mac's grant away.
import { openTerminal, evaluate, sleep, finish, waitFor, type, realClick } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo attention');
await waitFor(client, "document.querySelector('.launcher')?.hidden === true", 10000);
await sleep(400);

const problem = (fingerprint) => ({
  id: 'full-disk-access',
  level: 'problem',
  title: 'Full Disk Access is not granted to TabTerm',
  detail: 'An agent that reads another app’s data makes macOS ask on every launch.',
  fix: 'System Settings, Privacy & Security, Full Disk Access, add TabTerm.app.',
  fingerprint,
});
const note = {
  id: 'host-from-before-update',
  level: 'note',
  title: 'The terminal host is still the one from before an update',
  detail: 'Prompts name node rather than TabTerm.',
  fix: 'kill 4242 when ready.',
  fingerprint: 'host:/usr/local/bin/node',
};
const pretend = (concerns) =>
  evaluate(client, `window.__tabterm.attentionFixture(${JSON.stringify(concerns)})`);

r.ok(
  'a healthy tab shows no notice',
  !(await evaluate(client, "!!document.querySelector('.attention-notice')")),
);

await pretend([problem('fda:off'), note]);
r.ok(
  'a problem the daemon found is a notice in the corner',
  await waitFor(
    client,
    "document.querySelector('.attention-notice')?.textContent.includes('Full Disk Access')",
    5000,
  ),
);
r.ok(
  'and a note is not',
  Number(await evaluate(client, "document.querySelectorAll('.attention-notice').length")) === 1,
);

// Settings says both, first, with the fix.
await realClick(client, '.attention-notice-fix');
r.ok(
  'How to fix opens Settings on a Needs attention section',
  await waitFor(
    client,
    "document.querySelector('.cmd-settings')?.firstElementChild?.dataset.attention === 'true'",
    5000,
  ),
);
const section = () =>
  evaluate(client, "document.querySelector('[data-attention]')?.textContent ?? ''");
r.ok(
  'that names the problem and its fix',
  (await section()).includes('add TabTerm.app'),
  await section(),
);
r.ok('and the note too', (await section()).includes('before an update'), await section());

// Dismissed, and remembered for this situation.
await realClick(client, '.attention-notice-hide');
r.ok(
  'the cross puts the notice away',
  await waitFor(client, "!document.querySelector('.attention-notice')", 3000),
);
await pretend([problem('fda:off'), note]);
await sleep(800);
r.ok(
  'and the same situation stays quiet',
  !(await evaluate(client, "!!document.querySelector('.attention-notice')")),
);
r.ok('while Settings still lists it', (await section()).includes('Full Disk Access'));

await pretend([problem('fda:off:again')]);
r.ok(
  'a changed situation is said again',
  await waitFor(client, "!!document.querySelector('.attention-notice')", 5000),
);

await pretend([]);
r.ok(
  'and nothing is left once it is fixed',
  await waitFor(
    client,
    "!document.querySelector('.attention-notice') && !document.querySelector('[data-attention]')",
    5000,
  ),
);

await finish();
r.done();
