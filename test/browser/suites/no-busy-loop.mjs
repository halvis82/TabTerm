// An idle terminal tab must send nothing.
//
// This exists because it did not. A directory with no project config was recorded by *deleting*
// it, so "asked and the answer was nothing" was indistinguishable from "never asked". Every
// render asked again, every answer caused another render, and the launcher sent thousands of
// messages a second.
//
// Nothing looked broken. The loop is invisible, and what showed instead was every other message
// starved behind it: typing appeared to do nothing at all. It also grew worse the more the
// product was used, because each additional recent folder added another question per render.
import { openTerminal, evaluate, sleep, type, readScreen } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();

await evaluate(
  client,
  `(() => {
    window.__frames = 0;
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      window.__frames++;
      return orig.apply(this, arguments);
    };
  })()`,
);

await sleep(4000);
const idle = await evaluate(client, `window.__frames`);
// A handful would be acceptable; thousands is a loop. The threshold is deliberately loose so
// this fails on the bug rather than on ordinary chatter.
r.ok('an idle tab sends almost nothing', idle < 20, `${String(idle)} frames in 4s`);

// And the thing the loop broke: typing still has to work while the launcher is on screen.
await type(client, 'echo NOT-STARVED');
await sleep(1500);
r.ok('typing reaches the shell', (await readScreen(client)).includes('NOT-STARVED'));

r.done();
