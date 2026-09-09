// A program that redraws over its own last frame, which is how agent interfaces work.
//
// Claude Code renders with cursor-up and overwrite: 21,881 cursor-up sequences in one session,
// five erase-downs, no absolute positioning, no alternate screen. Nothing else in this suite
// exercises that, which is why a change that resized the terminal underneath such a program went
// unnoticed until a review agent's output came out unreadable.
//
// This runs a small stand-in for one, does the things that used to scramble it, and checks the
// screen against what the same bytes produce in a terminal nobody touched.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await waitFor(client, `(window.__tabterm.readViewport() ?? '').trim().length > 0`, 20000);

/**
 * Six lines, rewritten in place eight times, exactly as an in-place renderer does it.
 *
 * Printf rather than a script file: it has to survive being typed into a shell, and every escape
 * here is deliberate. `\033[6A` moves up over the frame just written, so each pass overwrites the
 * previous one and a correct terminal ends with one frame and no leftovers.
 */
const PAD = 'x'.repeat(60);
const FRAME = [
  'for i in $(seq 1 40); do',
  `printf "ROW-A pass $i ${PAD}\\nROW-B pass $i ${PAD}\\nROW-C pass $i ${PAD}\\nROW-D pass $i ${PAD}\\nROW-E pass $i ${PAD}\\nROW-F pass $i ${PAD}\\n";`,
  'sleep 0.2;',
  'if [ $i -lt 40 ]; then printf "\\033[6A"; fi;',
  'done',
].join(' ');

await type(client, FRAME);
// Running, and redrawing, which is the state the program has to be in for any of this to matter.
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('ROW-F pass 3')`, 30000);

const screen = async () => String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));

/** How many frames are on the screen. A correct one has exactly the last. */
const frames = (text) => (text.match(/ROW-A pass \d/g) ?? []).length;

const settled = await screen();
r.ok(
  'an in-place redraw leaves one frame, not a pile of them',
  frames(settled) === 1,
  `${String(frames(settled))} frames: ${(settled.match(/ROW-A pass \d/g) ?? []).join(', ')}`,
);
r.ok(
  'and every row on it belongs to the same pass',
  new Set(settled.match(/pass (\d+)/g) ?? []).size === 1,
  (settled.match(/ROW-[A-F] pass \d+/g) ?? []).slice(-3).join(', '),
);

/**
 * And now the thing that used to ruin it: a tab coming back after a long absence.
 *
 * That used to shrink the terminal by a row and put it back, which scrolls the buffer underneath a
 * frame the program is about to overwrite. Every redraw after that landed a row out.
 */
await evaluate(client, 'window.__tabterm.redrawAfterAway()');
await sleep(1500);

const woken = await screen();
r.ok(
  'waking the tab does not multiply the frame',
  frames(woken) === 1,
  `${String(frames(woken))} frames after waking`,
);
r.ok(
  'and every row on it still belongs to the same pass',
  new Set(woken.match(/pass (\d+)/g) ?? []).size === 1,
  (woken.match(/ROW-[A-F] pass \d+/g) ?? []).slice(-3).join(', '),
);

/**
 * And the case this product actually controls: opening the tab again.
 *
 * A genuine width change stacks frames for any program that redraws in place, and no terminal can
 * prevent that: a second, narrower view really does constrain the size, and iTerm resized by hand
 * does the same. What must not happen is the width changing when nobody asked, and that is what a
 * reattach used to do, announcing a pane measured before the layout had settled and correcting it a
 * second later.
 */
await evaluate(client, 'location.reload()');
await sleep(3000);
await waitFor(client, `document.querySelectorAll('.pane').length > 0`, 20000);
await sleep(3000);

const reattached = await screen();
r.ok(
  'reopening the tab does not multiply the frame',
  frames(reattached) === 1,
  `${String(frames(reattached))} frames: ${(reattached.match(/ROW-A pass \d+/g) ?? []).slice(0, 8).join(', ')}`,
);
r.ok(
  'and leaves no row from an earlier pass stranded on the screen',
  new Set(reattached.match(/pass (\d+)/g) ?? []).size <= 1,
  (reattached.match(/ROW-[A-F] pass \d+/g) ?? []).slice(0, 8).join(', '),
);

await finish();
r.done();
