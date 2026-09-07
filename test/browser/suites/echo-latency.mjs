// How long a keystroke takes to come back, which is what "laggy" means.
//
// A terminal in a browser has more between the key and the pixel than one that owns its own PTY:
// the host, a socket, the daemon, a websocket, then the emulator. Every piece of work done on
// that path before the bytes are forwarded is added to it.
//
// Measured as a round trip: write a character, wait for it to appear. That is what a person feels
// when they scroll a program that redraws, which is a keystroke by another name.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'stty -echo 2>/dev/null; printf ready\\n');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('ready')`, 15000);
await sleep(800);

/**
 * One round trip: ask the shell to print a token, and wait for it on screen.
 *
 * `performance.now` in the page on both sides, so the number is what the page waited and does not
 * include anything the harness spent getting here.
 */
const roundTrip = async (n) =>
  Number(
    await evaluate(
      client,
      `(async () => {
         const token = 'RT-${String(n)}-' + Math.random().toString(36).slice(2, 8);
         const started = performance.now();
         window.__tabterm.writeToPane(window.__tabterm.paneIds()[0], 'printf ' + token + '\\\\n\\r');
         for (let i = 0; i < 4000; i++) {
           if ((window.__tabterm.readScreen() ?? '').includes(token)) return performance.now() - started;
           await new Promise((done) => requestAnimationFrame(done));
         }
         return -1;
       })()`,
    ),
  );

const samples = [];
for (let i = 0; i < 12; i++) {
  const ms = await roundTrip(i);
  if (ms > 0) samples.push(ms);
  await sleep(120);
}
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)] ?? -1;
const best = samples[0] ?? -1;

console.log(`    round trip: best ${best.toFixed(0)} ms, median ${median.toFixed(0)} ms`);
r.ok('a round trip completes at all', samples.length >= 6, `${String(samples.length)} of 12`);
r.ok(
  'and comes back quickly enough to feel immediate',
  median > 0 && median < 120,
  `best ${best.toFixed(0)} ms, median ${median.toFixed(0)} ms of ${JSON.stringify(samples.map((s) => Math.round(s)))}`,
);

await finish();
r.done();
