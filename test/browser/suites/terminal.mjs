// The premise: a Chrome tab is a real terminal.
import {
  openTerminal,
  type,
  readScreen,
  paneCount,
  interrupt,
  press,
  sleep,
  finish,
  waitFor,
} from '../helpers.mjs';
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

/**
 * And after interrupting a full-screen program, the shell is usable again.
 *
 * Reported as "when i close an agent session, i can't always type commands again". An agent runs
 * in the alternate screen, and a terminal left in it after the program has gone shows a shell
 * that answers nothing: the prompt is there, typing reaches it, and the output is drawn on a
 * screen nobody is looking at. It is indistinguishable from a hung terminal.
 *
 * The program here is not an agent, because none is installed. It is the part of an agent that
 * matters: something that switches to the alternate screen and then is interrupted.
 */
{
  const AFTER = `AFTER-INTERRUPT-${String(Date.now()).slice(-6)}`;
  await type(client, `printf '\\033[?1049h'; /bin/sleep 30`);
  await sleep(1200);
  await interrupt(client);
  await sleep(1200);
  await type(client, `echo ${AFTER}`);
  const usable = await waitFor(
    client,
    `(window.__tabterm.readScreen() ?? '').includes(${JSON.stringify(AFTER)})`,
    10000,
  );
  r.ok(
    'a shell interrupted out of a full-screen program still runs commands',
    usable,
    (await readScreen(client)).trim().split('\n').slice(-2).join(' | '),
  );
}

await finish();
r.done();
