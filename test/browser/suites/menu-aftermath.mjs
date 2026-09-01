// What the screen looks like after the menu acts, and what the folder box says as you type.
//
// Both are the same question: does the terminal end up in a state a shell would ever produce?
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  realClick,
  openPaneMenu,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// This one writes to a real home directory, so it takes its own folder away again.
const MADE = join(homedir(), 'tabterm-suite-made-this');

const r = reporter();
const { client } = await openTerminal();
await sleep(4500);
await type(client, 'echo before-clearing\r');
await sleep(1400);

const lines = async () =>
  (await evaluate(client, 'window.__tabterm.readScreen()'))
    .split(String.fromCharCode(10))
    .filter((l) => l.trim() !== '');

await openPaneMenu(client, 60, 60);
await realClick(client, '.term-menu-item', 'Clear');
await sleep(1600);
const cleared = await lines();
r.ok(
  'Clear leaves a prompt, the way typing clear does',
  cleared.length === 1 && cleared[0].includes('%'),
  JSON.stringify(cleared),
);
r.ok('and nothing above it', !cleared.join(' ').includes('before-clearing'));

await openPaneMenu(client, 60, 60);
await realClick(client, '.term-menu-item', 'Add a marker here');
await sleep(600);
r.ok(
  'the marker form is ready to type in',
  String(await evaluate(client, "document.activeElement?.className ?? ''")).includes(
    'pane-label-input',
  ),
);
r.ok(
  'and says what it is for, rather than naming a pane',
  String(
    await evaluate(client, "document.querySelector('.pane-label-input')?.placeholder ?? ''"),
  ).includes('marker'),
);
await evaluate(client, "document.querySelector('.pane-label-input').value = 'a landmark'");
await realClick(client, '.pane-label-form .term-menu-item', 'Save');
await sleep(2400);

const afterMarker = await lines();
r.ok(
  'a prompt follows the marker, so the next command is not typed against a bare line',
  (afterMarker[afterMarker.length - 1] ?? '').includes('%'),
  JSON.stringify(afterMarker[afterMarker.length - 1]),
);

// The start screen says whether a folder is there, and offers to make one that is not.
const fresh = await openTerminal();
await sleep(5000);
const typePath = async (text) => {
  await evaluate(
    fresh.client,
    `(() => { const i = document.querySelector('.launcher-input'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(1300);
  return String(
    await evaluate(
      fresh.client,
      "document.querySelector('.launcher-folder-state')?.textContent ?? ''",
    ),
  );
};

r.ok('a folder that exists says so', (await typePath('~/Documents')).includes('exists'));

const missing = await typePath('~/tabterm-suite-made-this');
r.ok('one that does not says that instead', missing.includes('no folder there yet'), missing);
r.ok(
  'and offers to create it',
  await evaluate(fresh.client, "!!document.querySelector('.launcher-create-folder')"),
);

await realClick(fresh.client, '.launcher-create-folder');
await sleep(1800);
r.ok(
  'creating it makes the offer go away',
  String(
    await evaluate(
      fresh.client,
      "document.querySelector('.launcher-folder-state')?.textContent ?? ''",
    ),
  ).includes('exists'),
);

await rm(MADE, { recursive: true, force: true });
await finish();
r.done();
