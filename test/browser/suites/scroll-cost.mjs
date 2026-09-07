// What one scroll gesture costs when a full-screen program owns the screen.
//
// Reported as Claude tabs scrolling worse than ordinary ones. They are not the same act. An
// ordinary tab scrolls its own scrollback, which is local and instant. A program that has taken
// the alternate screen owns what is drawn, so the terminal cannot scroll anything: it turns the
// wheel into input and the program redraws.
//
// Which means every wheel event is a round trip and a repaint. A trackpad produces them in the
// dozens per flick, and they queue: the screen lags behind the finger and keeps going after it
// stops. That is the lag, and it is a count rather than a duration.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.pane')");

// A program that owns the screen. `tput smcup` is the part of an agent that matters here.
await type(client, 'tput smcup; sleep 60');
await sleep(2500);
const inAlt = String(await evaluate(client, `window.__tabterm.geometry() ? 'yes' : 'no'`));
r.ok('a pane to scroll in', inAlt === 'yes');

/** One flick, as a trackpad delivers it: many small events in quick succession. */
const flick = async (events = 40) => {
  const box = JSON.parse(
    await evaluate(
      client,
      `(() => { const p = document.querySelector('.pane').getBoundingClientRect();
         return JSON.stringify({ x: Math.round(p.left + p.width / 2), y: Math.round(p.top + p.height / 2) }); })()`,
    ),
  );
  for (let i = 0; i < events; i++) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: box.x,
      y: box.y,
      deltaX: 0,
      deltaY: -12,
    });
  }
};

const before = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.inputSent())'));
await flick(40);
await sleep(900);
const after = JSON.parse(await evaluate(client, 'JSON.stringify(window.__tabterm.inputSent())'));
const writes = after.writes - before.writes;

console.log(
  `    a 40 event flick sent ${String(writes)} writes, ${String(after.bytes - before.bytes)} bytes`,
);

/**
 * Wheel events do not become one message each.
 *
 * Measured at seven for forty, because the emulator already gathers them: it acts once a wheel
 * has moved a whole line rather than once per event. Worth holding, since the failure it would
 * catch is every event becoming a round trip and a repaint, which is what scrolling a program
 * that owns the screen would feel like.
 */
r.ok(
  'a flick does not send one message per wheel event',
  writes > 0 && writes <= 12,
  `${String(writes)} writes for 40 events`,
);

await finish();
r.done();
