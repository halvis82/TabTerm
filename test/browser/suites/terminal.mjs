// The premise: a Chrome tab is a real terminal.
import { openTerminal, type, readScreen, paneCount, interrupt, press, sleep } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const MARKER = `TERM-${String(Date.now()).slice(-6)}`;
const { client } = await openTerminal();

r.ok('a terminal page attaches to a session', (await paneCount(client)) === 1);

await type(client, `echo ${MARKER}`);
await sleep(1200);
r.ok('a real shell runs and echoes output', (await readScreen(client)).includes(MARKER));

// Control keys reach the shell. The most important key in a terminal.
await type(client, '/bin/sleep 30');
await sleep(900);
await interrupt(client);
await sleep(1000);
r.ok('Ctrl+C interrupts a running command', (await readScreen(client)).includes('^C'));

// Command keys do not.
await type(client, '/bin/sleep 30');
await sleep(900);
const before = (await readScreen(client)).trim().split('\n').length;
await press(client, 'c', 'KeyC', 4, 67);
await sleep(900);
r.ok(
  'Command+C does not interrupt',
  before === (await readScreen(client)).trim().split('\n').length,
);
await interrupt(client);
await sleep(600);

r.done();
