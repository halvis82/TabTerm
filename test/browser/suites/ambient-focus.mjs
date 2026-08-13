// A terminal you never have to click into.
//
// Terminals have no other controls, so nobody expects to focus one before typing. This page
// does have other controls, and clicking any of them used to take the keyboard away with no way
// back except clicking the terminal again. That is not how a terminal behaves.
//
// The panel over the empty output is part of the same idea: it is drawn on top because there is
// no output yet, not a page you have to leave. It survives typing and goes when a command is
// actually sent.
import { openTerminal, readScreen, evaluate, sleep, finish } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

const launcherUp = () => evaluate(client, `!document.querySelector('.launcher')?.hidden`);
const activeClass = () =>
  evaluate(client, `document.activeElement?.className ?? document.activeElement?.tagName ?? ''`);

r.ok('the panel is showing over an empty terminal', (await launcherUp()) === true);

// Type without ever clicking the terminal. openTerminal does not focus it.
await evaluate(client, `document.body.focus()`);
await client.send('Input.dispatchKeyEvent', { type: 'char', text: 'e', unmodifiedText: 'e' });
await sleep(400);
r.ok(
  'typing moves focus to the terminal by itself',
  String(await activeClass()).includes('xterm-helper-textarea'),
  String(await activeClass()),
);

// The panel must still be there mid-command.
for (const ch of 'cho AMBIENT-ONE') {
  await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
  await sleep(4);
}
await sleep(400);
r.ok('the panel survives typing', (await launcherUp()) === true);
r.ok(
  'and the half-typed command is on the prompt',
  (await readScreen(client)).includes('echo AMBIENT-ONE'),
  (await readScreen(client)).split('\n').filter(Boolean).pop(),
);

// Sending the command is what takes it away.
await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r' });
await sleep(1200);
r.ok('sending the command dismisses the panel', (await launcherUp()) === false);
r.ok('and the command ran', (await readScreen(client)).includes('AMBIENT-ONE'));

// Clicking something else and then typing must land in the terminal, which is the case that
// made this necessary: a launcher full of buttons is a lot of places to lose the keyboard.
const second = await openTerminal();
await evaluate(second.client, `document.querySelector('.launcher-heading')?.click()`);
await sleep(300);
await second.client.send('Input.dispatchKeyEvent', {
  type: 'char',
  text: 'x',
  unmodifiedText: 'x',
});
await sleep(500);
r.ok(
  'clicking the panel then typing still reaches the terminal',
  (await readScreen(second.client)).trimEnd().endsWith('x'),
  (await readScreen(second.client)).split('\n').filter(Boolean).pop(),
);

// A real text field is the exception. Typing into the folder box must go to the folder box.
await evaluate(second.client, `document.querySelector('.launcher-input')?.focus()`);
await sleep(200);
for (const ch of '/tmp') {
  await second.client.send('Input.dispatchKeyEvent', {
    type: 'char',
    text: ch,
    unmodifiedText: ch,
  });
  await sleep(10);
}
await sleep(300);
r.ok(
  'but a real text field keeps its own keys',
  (await evaluate(second.client, `document.querySelector('.launcher-input')?.value`)) === '/tmp',
  String(await evaluate(second.client, `document.querySelector('.launcher-input')?.value`)),
);
r.ok('and nothing leaked into the terminal', !(await readScreen(second.client)).includes('/tmp'));

await finish();
r.done();
