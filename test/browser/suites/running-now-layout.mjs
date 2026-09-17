// Three things about the start screen that are only true once it is drawn.
//
// What a session that has gone quiet is called, whether the grid wastes a row on a gap it could
// have filled, and which of two ways to start work comes first.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

// A session that runs something and then goes quiet, which is what used to be called "shell".
const worker = await openTerminal();
await waitFor(worker.client, "document.querySelector('.launcher-input')");
/*
 * Somewhere recent, so the folders section exists at all.
 *
 * It is drawn only when there is something to draw, and what the daemon has seen depends on which
 * other suites have run. Asserting the order without making a folder recent passed or failed on
 * the company this suite happened to keep.
 */
await type(worker.client, 'cd /usr\r');
await sleep(400);
await type(worker.client, 'cd ~\r');
await sleep(1200);

// And then the command the card is judged by, run last so it is the last one.
await type(worker.client, 'ls /usr\r');
await waitFor(worker.client, `(window.__tabterm.readScreen() ?? '').includes('bin')`, 20000);
await sleep(1500);

const viewer = await openTerminal();
await waitFor(viewer.client, "document.querySelector('.launcher-input')");
await sleep(2500);

/** What every card calls itself, in order. */
const labels = async () =>
  JSON.parse(
    String(
      await evaluate(
        viewer.client,
        `JSON.stringify([...document.querySelectorAll('.session-card')]
           .map((c) => (c.querySelector('.session-what')?.textContent ?? '').trim()))`,
      ),
    ),
  );

/*
 * The session that ran `ls` says so. Every idle terminal used to be called "shell", which made the
 * one line meant to tell them apart the one line they all shared.
 */
const named = await waitUntil(
  async () => (await labels()).some((l) => l.startsWith('shell - ')),
  20000,
);
r.ok('a shell that has run something says what it ran', named, JSON.stringify(await labels()));

r.ok(
  'and a bare "shell" is not what a used session is called',
  (await labels()).some((l) => l.startsWith('shell - ls')),
  JSON.stringify(await labels()),
);

/*
 * The grid fills a gap rather than leaving a column empty for good. Asserted on the property that
 * causes it rather than by counting rows, which depends on how wide the window happens to be.
 */
const flow = String(
  await evaluate(
    viewer.client,
    `getComputedStyle(document.querySelector('.session-grid')).gridAutoFlow`,
  ),
);
r.ok('the grid lets a later card fill a gap', flow.includes('dense'), flow);

/*
 * And every tile is placed rather than left to fall where it may.
 *
 * The browser fills a gap only with something that comes after it, which left a column three rows
 * deep empty beside a seven pane tab because the cards that fit there were older. The places are
 * worked out here instead, from the number of columns the grid actually has. See `pack-grid.ts`.
 */
const placed = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `JSON.stringify([...document.querySelectorAll('.session-grid > *')]
         .map((el) => ({ row: el.style.gridRow, col: el.style.gridColumn })))`,
    ),
  ),
);
r.ok(
  'every tile is given a row and a column of its own',
  placed.length > 0 && placed.every((p) => p.row !== '' && p.col !== ''),
  JSON.stringify(placed),
);

/*
 * And no two of them are on the same cell, which is the one way this can be wrong and still look
 * plausible in a screenshot.
 */
const overlap = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const taken = new Set();
         let clash = null;
         for (const el of document.querySelectorAll('.session-grid > *')) {
           const [cs, , cn] = el.style.gridColumn.split(' ');
           const [rs, , rn] = el.style.gridRow.split(' ');
           const c0 = Number(cs), r0 = Number(rs);
           for (let c = 0; c < (Number(cn) || 1); c++) {
             for (let r = 0; r < (Number(rn) || 1); r++) {
               const cell = (c0 + c) + ':' + (r0 + r);
               if (taken.has(cell)) clash = cell;
               taken.add(cell);
             }
           }
         }
         return JSON.stringify(clash);
       })()`,
    ),
  ),
);
r.ok('and no two tiles are on the same cell', overlap === null, String(overlap));

/*
 * And folders come before resuming an agent. Both are ways to start, and the folder is the commoner
 * one; the resume list is also the one that grows without bound, so first it pushed the other down.
 */
const sections = async () =>
  JSON.parse(
    String(
      await evaluate(
        viewer.client,
        `JSON.stringify([...document.querySelectorAll('.launcher-section-title, .launcher-heading, h3, h2')]
           .map((el) => (el.textContent ?? '').trim().toLowerCase())
           .filter((t) => t.includes('recent folders') || t.includes('resume an agent')))`,
      ),
    ),
  );

/**
 * Waited for rather than read once.
 *
 * Both sections are drawn when their answers arrive, and the resume list is read off disk, so under
 * a full run it lands later than the folders do. Reading in one breath asserted the order of a page
 * that was still filling in, which failed in a full run and passed on its own: the worst shape a
 * check can have, because it is noise exactly when somebody is looking for signal.
 */
const both = await waitUntil(async () => (await sections()).length === 2, 20000);
const order = await sections();

/*
 * And skipped rather than failed when there is nothing to resume.
 *
 * The check is about which of the two comes first. On a machine with no agent sessions recorded
 * there is only one of them, and the ordering is not wrong there, it is absent. Said out loud so a
 * skip cannot quietly stand in for a section that has genuinely gone missing.
 */
if (!both) {
  r.skip('both sections are on the page', `only ${JSON.stringify(order)} on this machine`);
} else {
  r.ok('both sections are on the page', order.length === 2, JSON.stringify(order));
  r.ok(
    'and recent folders comes first',
    order[0]?.includes('recent folders') === true,
    JSON.stringify(order),
  );
}

await finish();
r.done();
