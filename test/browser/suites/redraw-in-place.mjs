// A program that redraws in place is not left with copies of itself on the screen.
//
// This is the symptom as it was actually reported: not a table at the wrong width, but the same
// table three times at three different widths, stacked.
//
// The mechanism is the redraw, not the size. A program that draws its interface in place moves the
// cursor up by the number of rows it believes it printed, erases them, and draws again. That row
// count depends on the width, because a wrapped line takes more rows at a narrower one. So if the
// width changes between the draw and the erase, the erase clears the wrong number of rows: the old
// frame stays on the screen and the new one lands underneath it. Every extra size change is one
// more stranded copy.
//
// Which is why the thing being asserted is a count of resizes and a count of copies on the screen,
// rather than the size anything ended up at. One size change for one thing a person did is correct
// and invisible. Two, for one action, is a copy.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

const paneId = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')))[0];

const screen = async () => String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));

/*
 * A stand-in for the thing that breaks, written the way those programs are written.
 *
 * It draws a block, and on every SIGWINCH it goes back up by the number of **lines it printed**
 * and draws the block again. That is the arithmetic every in-place renderer does, and it is the
 * arithmetic that stops holding when the width changes underneath it. Deliberately naive: the
 * point is that the platform must not put it in that position, not that the program is clever.
 */
const PROGRAM = [
  `printf 'REDRAW-START\\n'`,
  `draw() { printf 'ROWMARK alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu\\nROWMARK second line of the very same block to make the wrap likely\\n'; }`,
  `draw`,
  `trap 'printf "\\033[2A"; draw' WINCH`,
  `while true; do sleep 0.4; done`,
].join('; ');

await type(client, `${PROGRAM}\r`);
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('REDRAW-START')`, 20000);
await sleep(800);

const id = await paneId();
/*
 * Counted only where the block actually starts a line.
 *
 * The command that sets the program up contains the marker too, because it is the thing that
 * prints it, and the shell echoes what was typed. Counting every line that mentions it counted the
 * echo and started at four.
 */
const countMarks = (text) =>
  text.split('\n').filter((l) => l.trimStart().startsWith('ROWMARK')).length;

const before = countMarks(await screen());
r.ok('the block is on the screen once, two lines of it', before === 2, String(before));

const changesBefore = Number(
  await evaluate(client, `window.__tabterm.daemonSizeChangesFor(${JSON.stringify(id)})`),
);

/*
 * One thing a person did: the window made narrower, once.
 *
 * Narrower rather than wider on purpose. Widening unwraps and the naive arithmetic survives it;
 * narrowing is where a line that took one row starts taking two, which is the case that strands a
 * frame when the platform sends more than one size for one action.
 */
/*
 * Dragged rather than teleported, because a person drags.
 *
 * One jump to the final width produces one layout change and one size, which passes whether or not
 * anything coalesces. A drag is a stream of intermediate widths, and it is the stream that used to
 * become a stream of SIGWINCHes: twenty-eight frames of a drag became fifty-eight messages, and an
 * agent redraws its whole interface for every one it is told about.
 */
for (const width of [1150, 1080, 1010, 950, 890, 830, 770, 700]) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(60);
}
await sleep(2500);

const changesAfter = Number(
  await evaluate(client, `window.__tabterm.daemonSizeChangesFor(${JSON.stringify(id)})`),
);
/*
 * One drag is one thing a person did, so it is allowed to land as one size. Two is the settling
 * that a reattach sometimes needs. Eight, one per frame of the drag, is the storm.
 */
r.ok(
  'a whole drag resized the session once or twice, not once per frame',
  changesAfter - changesBefore <= 2,
  `${String(changesBefore)} -> ${String(changesAfter)} across eight frames of a drag`,
);

/*
 * And the screen holds one copy of the block.
 *
 * The count is what the report was about. A second copy is not a cosmetic problem: it is the
 * program's previous frame, stranded, and nothing will ever clear it because the program believes
 * it already did.
 */
const after = countMarks(await screen());
r.ok(
  'and the block was not left on the screen twice',
  after <= 2,
  `${String(before)} -> ${String(after)}`,
);

// Settled, and still one copy: a late second resize would show up here rather than above.
await sleep(2500);
const settled = countMarks(await screen());
r.ok('and still once after it has settled', settled <= 2, String(settled));
r.ok(
  'and no further resize arrived on its own',
  Number(await evaluate(client, `window.__tabterm.daemonSizeChangesFor(${JSON.stringify(id)})`)) ===
    changesAfter,
  String(changesAfter),
);

await client.send('Emulation.clearDeviceMetricsOverride');
await sleep(1500);

/*
 * And back again, which is the second half of one person-sized action and must cost one resize.
 */
const wideAgain = Number(
  await evaluate(client, `window.__tabterm.daemonSizeChangesFor(${JSON.stringify(id)})`),
);
r.ok(
  'putting the window back is also one resize, not a burst',
  wideAgain - changesAfter <= 1,
  `${String(changesAfter)} -> ${String(wideAgain)}`,
);

await waitUntil(async () => countMarks(await screen()) <= 2, 8000);
r.ok('and the screen still holds one copy of the block', countMarks(await screen()) <= 2);

await finish();
r.done();
