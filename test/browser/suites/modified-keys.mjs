// Whether a program that asks to be told about modifiers is told.
//
// A terminal cannot say "Shift and Return" in its own alphabet: Return is one byte, and a modifier
// that does not change the character has nowhere to go. `modifyOtherKeys` is how a program asks to
// be told anyway. xterm.js parses the request and does nothing with it, so an agent's Shift and
// Return arrived as a bare carriage return and was read as "send this" rather than "new line".
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  press,
  interrupt,
  finish,
  waitFor,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

// `cat -v` prints control characters instead of acting on them, so what arrives is readable.
const screen = () => evaluate(client, 'window.__tabterm?.readScreen() ?? ""');

await type(client, 'cat -v');
await sleep(900);

// Alt=1, Ctrl=2, Meta=4, Shift=8 in CDP's modifier bits.
const SHIFT = 8;
const OPTION = 1;

await press(client, 'Enter', 'Enter', SHIFT, 13);
await sleep(400);
const plain = String(await screen());
r.ok(
  'Shift and Return sends the escape a new line is asked for with',
  // `cat -v` prints an escape as ^[, and the carriage return after it starts a fresh line.
  plain.includes('^['),
  plain.slice(-120),
);
r.ok(
  'and not the reporting form, since nothing has asked for it',
  !plain.includes('27;2;13'),
  plain.slice(-120),
);

await interrupt(client);
await sleep(400);

// The request itself, sent up the pty the way a real program sends it.
await type(client, "printf '\\033[>4;2m'; cat -v");
await sleep(900);

await press(client, 'Enter', 'Enter', SHIFT, 13);
await sleep(400);
const shifted = String(await screen());
r.ok('and is reported once a program asks', shifted.includes('27;2;13'), shifted.slice(-120));

await press(client, 'Enter', 'Enter', OPTION, 13);
await sleep(400);
const optioned = String(await screen());
r.ok(
  'Option and Return is reported apart from Shift and Return',
  optioned.includes('27;3;13'),
  optioned.slice(-120),
);

await press(client, 'Enter', 'Enter', 0, 13);
await sleep(400);
const bare = String(await screen());
r.ok('and a Return held alone is left alone', !bare.includes('27;1;13'), bare.slice(-120));

await interrupt(client);
await finish();
r.done();
