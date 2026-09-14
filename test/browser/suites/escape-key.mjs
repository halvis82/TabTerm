// Escape reaches a program that reads keys the way an agent does.
//
// Written while answering a report that Escape did not register in an agent. It does, and this
// keeps that true. The report turned out to be about a feature that needs two presses, but the
// question underneath it is worth a check of its own: a terminal that swallowed Escape would
// break interrupting anything, and nothing here covered it.
//
// Raw mode and focus reporting, because that is what an agent actually does. A check against a
// shell prompt would pass over a terminal that only fails in the case that matters.
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const r = reporter();
const listener = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'fixtures',
  'key-listener.mjs',
);

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
const screen = () => evaluate(client, 'window.__tabterm?.readScreen() ?? ""');

await type(client, `node ${listener}\r`);
// Waits for the program to say it is listening rather than for a duration.
for (let i = 0; i < 30 && !String(await screen()).includes('SAW:'); i++) await sleep(300);

await press(client, 'Escape', 'Escape', 0, 27);
await sleep(500);
const once = String(await screen());
const lastReport = (t) => t.split('SAW:').pop() ?? '';

r.ok(
  'a raw-mode program is sent Escape as 1b',
  /1b(,|$|\s)/.test(lastReport(once)),
  lastReport(once).slice(0, 80),
);

// `1b 5b 49` is the focus-in report. A program that asked for focus reporting and never hears
// anything can decide it is in the background, which is a quieter way to lose every keystroke.
r.ok('and focus reporting answers, so it knows the terminal is focused', once.includes('1b,5b,49'));

const active = String(
  await evaluate(
    client,
    "document.activeElement?.tagName + '/' + document.activeElement?.className",
  ),
);
r.ok(
  'and the keyboard is on the terminal while that program runs',
  active.toLowerCase().includes('textarea'),
  active,
);

// Two in quick succession both arrive, which is what the double press an agent uses is built on.
await press(client, 'Escape', 'Escape', 0, 27);
await sleep(80);
await press(client, 'Escape', 'Escape', 0, 27);
await sleep(600);
const thrice = String(await screen());
r.ok(
  'and a fast repeat is not coalesced away',
  /1b,1b,1b/.test(lastReport(thrice)),
  lastReport(thrice).slice(0, 120),
);

await interrupt(client);
await sleep(300);
await finish();
r.done();
