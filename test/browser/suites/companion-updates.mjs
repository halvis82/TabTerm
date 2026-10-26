import { openTerminal, evaluate, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
const r = reporter();
const a = await openTerminal();
await waitFor(a.client, "document.querySelector('.launcher-input')");
await evaluate(a.client, "document.querySelector('#cmd-button')?.click()");
await waitFor(a.client, "document.querySelector('.cmd-panel')?.hidden === false");
await evaluate(a.client, "document.querySelector('.cmd-gear')?.click()");
const section = 'document.querySelector("[data-updates]")';
r.ok(
  'settings shows companion and extension versions',
  await waitFor(
    a.client,
    `${section}?.textContent.includes('Extension') && ${section}?.textContent.includes('Companion')`,
  ),
);
r.ok(
  'a current daemon answers with update controls',
  await waitFor(
    a.client,
    `[...(${section}?.querySelectorAll('button') ?? [])].some((b) => b.textContent === 'Check for updates')`,
  ),
);
r.ok(
  'automatic checks and installs are on by default',
  await evaluate(
    a.client,
    `[...${section}.querySelectorAll('input[type=checkbox]')].length === 2 && [...${section}.querySelectorAll('input[type=checkbox]')].every(x=>x.checked)`,
  ),
);
// Asked for: the update controls at the bottom of the page, drawn like the rest of it.
r.ok(
  'the section is the last one on the settings page',
  await evaluate(
    a.client,
    `document.querySelector('.cmd-settings')?.lastElementChild === ${section}`,
  ),
);
r.ok(
  "and its buttons are the panel's own buttons rather than the browser's",
  await evaluate(
    a.client,
    `[...${section}.querySelectorAll('button')].every((b) => b.classList.contains('cmd-button'))`,
  ),
);
r.ok(
  'and its switches are drawn like every other switch',
  await evaluate(
    a.client,
    `${section}.querySelectorAll('.set-toggle input[type=checkbox]').length === 2`,
  ),
);
r.ok(
  'Update companion is not offered until a newer compatible release is found',
  await evaluate(
    a.client,
    `![...${section}.querySelectorAll('button')].some((b) => b.textContent === 'Update companion')`,
  ),
);
r.ok(
  'and a button that cannot be pressed looks it',
  await evaluate(
    a.client,
    `(() => { const b = document.createElement('button'); b.className = 'cmd-button primary'; b.disabled = true; ${section}.append(b); const o = getComputedStyle(b).opacity; b.remove(); return Number(o) < 1; })()`,
  ),
);
r.ok(
  'the setup guide is available',
  await evaluate(
    a.client,
    `${section}.querySelector('a').href === 'https://github.com/halvis82/TabTerm#setup'`,
  ),
);
// A second tab reads the same daemon preferences without making a remote update request.
const b = await openTerminal();
await waitFor(b.client, "document.querySelector('.launcher-input')");
await evaluate(b.client, "document.querySelector('#cmd-button')?.click()");
await waitFor(b.client, "document.querySelector('.cmd-panel')?.hidden === false");
await evaluate(b.client, "document.querySelector('.cmd-gear')?.click()");
r.ok(
  'another tab gets the same defaults',
  await waitFor(
    b.client,
    `${section}?.querySelectorAll('input[type=checkbox]').length === 2 && [...${section}.querySelectorAll('input[type=checkbox]')].every(x=>x.checked)`,
  ),
);
await finish();
r.done();
