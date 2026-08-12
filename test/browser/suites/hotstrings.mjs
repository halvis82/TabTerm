// A hotstring expands into a real shell, against a real line editor.
//
// The unit tests decide when expansion should fire. This proves the rewriting works: the
// deletions land, the command replaces the abbreviation, and Enter still submits.
import { openTerminal, evaluate, readScreen, sleep } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await sleep(600);

// Unique per run, because hotstrings are unique by design and this writes into the real
// favorites list. A leftover from a previous run would collide with itself and look exactly
// like the feature being broken -- which is how it presented the first time.
const TAG = String(Date.now()).slice(-6);
const TRIGGER = `hs${TAG}!`;
const COMMAND = `echo HOTSTRING-${TAG}`;
const q = (value) => JSON.stringify(value);

await evaluate(client, `window.__tabterm.saveItem(${q(COMMAND)}, 'Hotstring test')`);
await sleep(1000);

const id = await evaluate(
  client,
  `(() => {
    const hit = (window.__tabterm.savedItems() ?? []).find(i => i.body === ${q(COMMAND)});
    return hit ? hit.id : '';
  })()`,
);
r.ok('a favorite was created', typeof id === 'string' && id.length > 0);

await evaluate(client, `window.__tabterm.updateSaved(${q(id)}, { hotstring: ${q(TRIGGER)} })`);
await sleep(1000);

const stored = await evaluate(
  client,
  `(() => {
    const hit = (window.__tabterm.savedItems() ?? []).find(i => i.id === ${q(id)});
    return (hit ?? {}).hotstring ?? '';
  })()`,
);
r.ok(
  'the hotstring is stored on it',
  stored === TRIGGER,
  `${String(stored)}${stored ? '' : ` (${String(await evaluate(client, `window.__tabterm.lastSaveRejection()`))})`}`,
);

const typeChars = async (text) => {
  await evaluate(client, `document.querySelector('.pane.focused .xterm-helper-textarea')?.focus()`);
  for (const ch of text) {
    await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
    await sleep(8);
  }
};
const lastLine = async () => (await readScreen(client)).split('\n').filter(Boolean).pop() ?? '';

// Typing the abbreviation and a space must leave the command at the prompt.
await typeChars(TRIGGER);
await typeChars(' ');
await sleep(800);

const expanded = await lastLine();
r.ok('typing the abbreviation and a space expands it', expanded.includes(COMMAND), expanded);
r.ok('and the abbreviation itself is gone', !expanded.includes(TRIGGER), expanded);

// Enter submits the expanded command rather than needing a second keystroke.
await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r' });
await sleep(1300);
r.ok('the expanded command runs', (await readScreen(client)).includes(`HOTSTRING-${TAG}`));

// A word that merely starts with the abbreviation must survive untouched.
await typeChars(`echo hs${TAG}`);
await typeChars(' ');
await sleep(700);
const near = await lastLine();
r.ok('a near miss is left alone', near.includes(`echo hs${TAG}`) && !near.includes(COMMAND), near);

// A second favorite cannot steal the same trigger.
await client.send('Input.dispatchKeyEvent', {
  type: 'char',
  text: '\u0003',
  unmodifiedText: '\u0003',
});
await evaluate(client, `window.__tabterm.saveItem('echo SECOND-${TAG}', 'Second')`);
await sleep(900);
const second = await evaluate(
  client,
  `(() => {
    const hit = (window.__tabterm.savedItems() ?? []).find(i => i.body === 'echo SECOND-${TAG}');
    return hit ? hit.id : '';
  })()`,
);
await evaluate(client, `window.__tabterm.updateSaved(${q(second)}, { hotstring: ${q(TRIGGER)} })`);
await sleep(900);
r.ok(
  'a duplicate trigger is refused, and says why',
  String(await evaluate(client, `window.__tabterm.lastSaveRejection()`)).includes('already uses'),
  String(await evaluate(client, `window.__tabterm.lastSaveRejection()`)),
);

// Clean up: this wrote into the real favorites list.
for (const each of [id, second]) {
  if (each) await evaluate(client, `window.__tabterm.deleteSaved(${q(each)})`);
}
await sleep(500);

r.done();
