// What is started from the start screen is started at the size of the pane it will run in.
//
// The strip under the start screen is a few rows tall on purpose: the terminal keeps the bottom of
// the window while the screen is up. Every launch measured that strip and asked the daemon for it,
// so a session was spawned into three rows and resized to forty seven a moment later.
//
// For a shell that is one reflow and invisible. For an agent it is fatal: there is no room to draw
// an interface at all. Read out of his own daemon log, `pty.spawned cols 163 rows 3`, and that
// session was gone twenty four seconds later. Reported as resuming an agent session "just not
// working at all", with a prompt answered by `Interrupted`.
//
// Checked through opening a folder, because every launch from this screen now asks the same way and
// a shell costs nobody anything. Resuming an agent takes the same road.
import { openTerminal, evaluate, sleep, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(800);

/** How tall the pane is right now, which while the start screen is up is the strip. */
const paneRows = async () =>
  Number(await evaluate(client, 'window.__tabterm.geometry()?.rows ?? -1'));

const strip = await paneRows();
r.ok(
  'the start screen leaves the terminal a few rows tall',
  strip > 0 && strip <= 12,
  `${String(strip)} rows under the start screen`,
);
r.ok(
  'and nothing has asked for a size yet',
  (await evaluate(client, 'JSON.stringify(window.__tabterm.lastRoomAsked())')) === 'null',
);

/*
 * Started with a layout rather than with an agent.
 *
 * `Open` sends a `cd` into the shell that is already there and starts nothing, so it never asks
 * for a size. A layout does, by the same road a resumed agent takes, and it costs nobody anything
 * to run: the shapes that ship as defaults run no commands at all.
 */
const chip = String(
  await evaluate(
    client,
    `(() => {
       const chips = [...document.querySelectorAll('.launcher-chip.launcher-template')]
         .filter((c) => !/claude|codex/i.test(c.textContent ?? ''));
       const wanted = chips[0];
       if (!wanted) return 'none';
       wanted.click();
       return wanted.textContent ?? 'unnamed';
     })()`,
  ),
);
r.ok('a layout can be started from the start screen', chip !== 'none', chip);
await waitUntil(async () => (await paneRows()) > strip, 15000);
await sleep(600);

const asked = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.lastRoomAsked())')),
);
const now = await paneRows();

r.ok('starting something asks the daemon for a size', asked !== null, JSON.stringify(asked));
r.ok(
  'and it is the pane it will run in, not the strip it was started from',
  asked !== null && asked.rows > strip + 4,
  `asked for ${String(asked?.rows)} rows, the strip was ${String(strip)}`,
);
/*
 * And it is that pane to within a row or two.
 *
 * Exact equality is not the claim: the measurement is taken as the screen goes and the pane can
 * settle a row either way afterwards. What must never happen again is asking for a size that
 * belongs to a screen which is on its way out.
 */
r.ok(
  'and it matches what the pane actually became',
  asked !== null && Math.abs(asked.rows - now) <= 2,
  `asked for ${String(asked?.rows)}, the pane is ${String(now)}`,
);

await finish();
r.done();
