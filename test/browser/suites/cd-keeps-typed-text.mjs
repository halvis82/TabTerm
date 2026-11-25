// A folder opened from the start screen runs only the cd, and what was typed waits for later.
//
// The start screen's command box is the shell's own line. Picking a folder typed `cd <folder>`
// after whatever was on it, so `echo half` became `echo halfcd '/private/tmp'`. Reported as the
// cd being run with the typed text prepended, and asked: keep what was typed for after the cd.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo half-typed-TAG', { submit: false });
await sleep(800);

await evaluate(
  client,
  `(() => { document.querySelector('.launcher-input').value = '/private/tmp'; })()`,
);
await evaluate(
  client,
  `[...document.querySelectorAll('.launcher-chip')].find((c) => c.firstChild?.textContent === 'Open')?.click()`,
);
// The next prompt, after the cd, holding whatever comes back to it.
await waitFor(
  client,
  `(window.__tabterm.readScreen() ?? '').split('\\n').some((l) => /tmp %/.test(l))`,
  10000,
).catch(() => {});
await sleep(800);

const screen = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));
r.ok(
  'only the cd ran, not the typed text with the cd stuck on its end',
  !screen.includes('half-typed-TAGcd') && !/no such file|not found/i.test(screen),
  screen.split('\n').filter(Boolean).slice(-3).join(' | '),
);
/*
 * Back on the line with the integration loaded (zsh's push-line). Without it the line is cleared,
 * which the check above already covers, so this one says which case it was in.
 */
const lastLine =
  screen
    .split('\n')
    .filter((l) => l.trim() !== '')
    .pop() ?? '';
const integrated = lastLine.includes('half-typed-TAG');
r.ok(
  'what was typed is back at the next prompt, or cleared without the integration',
  integrated || !lastLine.includes('echo'),
  lastLine,
);
if (integrated) {
  await type(client, '');
  await sleep(1200);
  await type(client, 'pwd');
  await sleep(1500);
  const after = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));
  r.ok(
    'and it runs in the new folder',
    after.includes('\nhalf-typed-TAG') || /^half-typed-TAG$/m.test(after),
    after.split('\n').filter(Boolean).slice(-4).join(' | '),
  );
  r.ok('the cd landed', /\/private\/tmp$/m.test(after) || after.includes('/private/tmp\n'));
}

await finish();
r.done();
