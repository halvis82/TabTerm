// The prompt is visible in the box at the bottom of the start screen, before and after a refresh.
//
// Reported three times, called fixed twice, and both fixes were wrong in the same way: they read
// the terminal buffer, and the text was in the buffer every time. It was being drawn at the top
// of a terminal still using the whole window, behind the opaque start screen, while the box at
// the bottom showed row 24 of a screen whose only line was row 1. Two places put the start screen
// up and only one of them told the terminal to make way.
//
// So this is measured in pixels. Nothing that reads text can catch it.
import { openTerminal, evaluate, sleep, finish, waitFor, inkIn, boxOf } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
// The shell has to have printed its prompt before there is anything to look for.
await waitFor(client, `(window.__tabterm.readViewport() ?? '').trim().length > 0`, 20000);
await sleep(900);

const strip = async () => {
  const box = await boxOf(client, '.pane');
  if (!box) return { ink: 0, sampled: 0, box: null };
  const measured = await inkIn(client, box);
  return { ...measured, box };
};

const before = await strip();
r.ok('the prompt is painted in the strip to begin with', before.ink > 0, JSON.stringify(before));

/**
 * The terminal is a strip while the start screen is up.
 *
 * Recorded as its own check because it is the thing that was actually broken: a full height
 * terminal under the panel has the prompt somewhere nobody can see, and every text-level
 * assertion still passes.
 */
const layout = JSON.parse(
  await evaluate(
    client,
    `(() => { const pane = document.querySelector('.pane');
       return JSON.stringify({
         panelOpen: document.getElementById('terminal')?.classList.contains('panel-open') ?? false,
         paneShare: pane ? pane.getBoundingClientRect().height / window.innerHeight : 1,
       }); })()`,
  ),
);
r.ok(
  'and the terminal is a strip rather than the whole window',
  layout.panelOpen && layout.paneShare < 0.5,
  JSON.stringify(layout),
);

await evaluate(client, 'location.reload()');
await sleep(6000);
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(1500);

const after = await strip();
r.ok(
  'and it is still painted there after a refresh',
  after.ink > 0,
  `${JSON.stringify(after)} was ${JSON.stringify(before)}`,
);

const afterLayout = JSON.parse(
  await evaluate(
    client,
    `(() => { const pane = document.querySelector('.pane');
       return JSON.stringify({
         panelOpen: document.getElementById('terminal')?.classList.contains('panel-open') ?? false,
         paneShare: pane ? pane.getBoundingClientRect().height / window.innerHeight : 1,
       }); })()`,
  ),
);
r.ok(
  'the refresh leaves the terminal a strip, which is what it stopped doing',
  afterLayout.panelOpen && afterLayout.paneShare < 0.5,
  JSON.stringify(afterLayout),
);

/**
 * The top border of the box is visible, which was reported three times as covered.
 *
 * The start screen's opaque edge sat two pixels over it. Fixed by measuring rather than
 * computing, and checked here in pixels for the same reason as everything else in this suite:
 * "it is covered" is a statement about the screen.
 *
 * The strip is the top few rows of the pane's own box. If the panel above it overlaps, those
 * rows are the panel's flat background and carry no border line at all.
 */
const border = await boxOf(client, '.pane');
if (border) {
  const line = await inkIn(client, {
    x: border.x + 20,
    y: border.y - 1,
    width: Math.max(20, border.width - 40),
    height: 3,
  });
  r.ok(
    'the top border of the box is drawn, not covered',
    line.ink > 0,
    JSON.stringify({ ...line, y: Math.round(border.y) }),
  );
  const gap = JSON.parse(
    await evaluate(
      client,
      `(() => {
         const pane = document.querySelector('.pane');
         const panel = document.querySelector('.launcher');
         if (!pane || !panel) return 'null';
         return JSON.stringify({
           overlap: Math.round(panel.getBoundingClientRect().bottom - pane.getBoundingClientRect().top),
         });
       })()`,
    ),
  );
  r.ok(
    'and the panel above it stops short of the pane rather than over it',
    gap !== null && gap.overlap <= 0,
    JSON.stringify(gap),
  );
}

await finish();
r.done();
