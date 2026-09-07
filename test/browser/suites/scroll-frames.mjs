// Scrolling a screen with a lot on it, measured in frames rather than in feelings.
//
// Reported as a Claude tab scrolling worse than an ordinary one. Read out of a real session's
// scrollback, Claude never takes the alternate screen and never asks for mouse events, so this is
// not a round trip to a program: it is the emulator scrolling its own buffer, exactly as in any
// other tab. What differs is what is in the buffer. An ordinary tab holds a few prompts; a tab
// that has been talking to an agent holds thousands of lines of coloured, boxed, wide-character
// text.
//
// So this fills a buffer with that kind of content and measures the frames while it scrolls.
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.pane')");
await sleep(800);

/** Fill the buffer the way an agent does: colour, box drawing, wide characters, long lines. */
await evaluate(
  client,
  `(() => {
     const ESC = String.fromCharCode(27);
     const pane = window.__tabterm.paneIds()[0];
     const rows = [];
     for (let i = 0; i < 4000; i++) {
       const colour = ESC + '[38;5;' + String(30 + (i % 200)) + 'm';
       const box = i % 7 === 0 ? '\\u2502 \\u256d\\u2500\\u2500\\u256e ' : '';
       rows.push(colour + box + 'line ' + String(i) + ' \\u2588\\u2593\\u2592 ' +
                 'some output with a fair amount of text on it '.repeat(2) + ESC + '[0m');
     }
     window.__tabterm.writeToPane(pane, rows.join('\\r\\n') + '\\r\\n');
   })()`,
);
await sleep(2500);

const lines = Number(await evaluate(client, `window.__tabterm.readScreen().split('\\n').length`));
r.ok('a buffer with a lot in it', lines > 500, `${String(lines)} lines`);

/**
 * Scroll it, and record how long each frame took.
 *
 * Frames rather than a total, because what a person feels is the worst frame rather than the
 * average: one long frame in a gesture is a visible stutter.
 */
const frames = JSON.parse(
  await evaluate(
    client,
    `(async () => {
       const term = document.querySelector('.xterm-viewport') || document.querySelector('.pane');
       const times = [];
       let last = performance.now();
       let running = true;
       const tick = () => {
         const now = performance.now();
         times.push(now - last);
         last = now;
         if (running) requestAnimationFrame(tick);
       };
       requestAnimationFrame(tick);
       for (let i = 0; i < 60; i++) {
         window.__tabterm.scrollLines(-3);
         await new Promise((done) => requestAnimationFrame(done));
       }
       running = false;
       await new Promise((done) => setTimeout(done, 60));
       return JSON.stringify(times.slice(2));
     })()`,
  ),
);
frames.sort((a, b) => a - b);
const median = frames[Math.floor(frames.length / 2)] ?? -1;
const worst = frames[frames.length - 1] ?? -1;

console.log(`    scrolling frames: median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
/**
 * A frame each, rather than a stutter.
 *
 * Sixteen and a bit milliseconds is one frame at sixty a second, which is as fast as a screen
 * changes. A worst frame far above that is a visible hitch in the middle of a gesture.
 */
r.ok(
  'a heavy buffer scrolls at a frame each',
  median > 0 && median < 25 && worst < 60,
  `median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`,
);

/** And it is doing that with the accelerated renderer, which is what makes it possible. */
const renderers = JSON.parse(
  await evaluate(client, 'JSON.stringify(window.__tabterm.renderers())'),
);
r.ok(
  'and it is drawing with the accelerated renderer',
  renderers.every((p) => p.webgl === true),
  JSON.stringify(renderers),
);

/**
 * And the work that runs after a scroll settles, which is where the buffer size shows.
 *
 * The rail beside the scrollbar is rebuilt from a walk of every row in the buffer, and that walk
 * is started again after every render. Scrolling renders, so a scroll costs a full scan of
 * everything the tab has ever printed, a fifth of a second after the finger stops.
 */
const scanned = Number(
  await evaluate(
    client,
    `(() => { const t0 = performance.now();
       window.__tabterm.syncMarkersNow();
       return performance.now() - t0; })()`,
  ),
);
r.ok(
  'rebuilding the rail over a full buffer stays cheap',
  scanned >= 0 && scanned < 25,
  `${scanned.toFixed(1)} ms`,
);

await finish();
r.done();
