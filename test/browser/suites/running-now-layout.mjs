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

/*
 * Which session is this suite's own, read now rather than later.
 *
 * Suites share a browser, and one of them opening a session into a tab can change what the first
 * pane of any tab is. Asking at the moment the check runs meant asking a question about whoever
 * had been there most recently: a full run had this suite reading a card labelled `claude`.
 */
const mine = JSON.parse(
  String(await evaluate(worker.client, 'JSON.stringify(window.__tabterm.paneSessions())')),
)[0]?.sessionId;

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
 *
 * Asked about **this suite's own session**, by its id. Reading every card on the page meant the
 * first of these passed on somebody else's terminal, and the second, which is the one that is
 * actually about the command run above, was left with no wait in front of it at all: a full run
 * caught it reading the list before the daemon had pushed what this session last ran.
 */
r.ok('this suite knows which session is its own', typeof mine === 'string' && mine !== '', mine);

/** What this suite's own card calls itself. */
const myLabel = async () =>
  String(
    await evaluate(
      viewer.client,
      `(document.querySelector('.session-card[data-session-id="' + ${JSON.stringify(mine ?? '')} + '"] .session-what')?.textContent ?? '').trim()`,
    ),
  );

/*
 * Asked again, rather than trusted from before the command was run.
 *
 * Reading it once at the start was supposed to settle which session is this suite's own, and it
 * did not: a full run read a card labelled `claude`, which belongs to whichever suite launched an
 * agent, twice now. The page this asks is this suite's own worker tab, so the answer is its
 * session by construction, and asking at the last moment leaves no window for it to become
 * somebody else's.
 */
const nowMine = JSON.parse(
  String(await evaluate(worker.client, 'JSON.stringify(window.__tabterm.paneSessions())')),
)[0]?.sessionId;
r.ok(
  'and it is still the same session it was',
  nowMine === mine,
  `${String(mine)} then, ${String(nowMine)} now`,
);
const named = await waitUntil(async () => (await myLabel()).startsWith('shell - '), 20000);
r.ok('a shell that has run something says what it ran', named, await myLabel());

const saysWhat = await waitUntil(async () => (await myLabel()).startsWith('shell - ls'), 20000);
r.ok(
  'and a bare "shell" is not what a used session is called',
  saysWhat,
  `${await myLabel()} — ${JSON.stringify(await labels())}`,
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
 * And no two cards are on the same cell, which is the one way this can be wrong and still look
 * plausible in a screenshot. A wash is left out of this on purpose: it is painted over the cells
 * of its own cards, which is what it is for.
 */
const overlap = String(
  await evaluate(
    viewer.client,
    `(() => {
       const taken = new Set();
       let clash = null;
       for (const el of document.querySelectorAll('.session-grid > .session-card')) {
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
       return String(clash);
     })()`,
  ),
);
r.ok('and no two cards are on the same cell', overlap === 'null', overlap);

/*
 * And no two tabs' colours touch, because two that meet read as one tab. Measured as drawn rather
 * than as placed: what matters is the pixels, and each wash deliberately reaches past its cards.
 */
const washesApart = String(
  await evaluate(
    viewer.client,
    `(() => {
       const washes = [...document.querySelectorAll('.session-wash')].map((w) => {
         const b = w.getBoundingClientRect();
         return { l: b.left, r: b.right, t: b.top, b: b.bottom };
       });
       for (let i = 0; i < washes.length; i++) {
         for (let j = i + 1; j < washes.length; j++) {
           const a = washes[i], c = washes[j];
           const overlaps = a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
           if (overlaps) return 'two washes overlap';
         }
       }
       return 'apart';
     })()`,
  ),
);
r.ok('and no two tab colours touch each other', washesApart === 'apart', washesApart);

/*
 * And the list never scrolls sideways. A wash reaches past its cards, and at the edge of the grid
 * that turned into a horizontal scrollbar on a list that is read downwards.
 */
const sideways = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => { const g = document.querySelector('.session-grid');
         return JSON.stringify({ scroll: g.scrollWidth, client: g.clientWidth }); })()`,
    ),
  ),
);
r.ok(
  'and the list never scrolls sideways',
  sideways.scroll <= sideways.client + 1,
  JSON.stringify(sideways),
);

/*
 * And the two rules that keep it that way, pinned rather than left to a scene that happens to
 * show them. A wash reaches past its cards, so it can only be safe if it reaches less than half
 * the gap, and the list must refuse sideways scrolling whatever anything else does.
 */
const rules = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `(() => {
         const grid = document.querySelector('.session-grid');
         const wash = document.querySelector('.session-wash');
         const g = getComputedStyle(grid);
         return JSON.stringify({
           gap: parseFloat(g.columnGap) || 0,
           overflowX: g.overflowX,
           padding: parseFloat(g.paddingLeft) || 0,
           reach: wash ? Math.abs(parseFloat(getComputedStyle(wash).marginLeft) || 0) : null,
         });
       })()`,
    ),
  ),
);
r.ok(
  'a tab colour reaches less than half the gap, so two can never meet',
  rules.reach === null || rules.reach * 2 < rules.gap,
  JSON.stringify(rules),
);
r.ok(
  'and the list refuses to scroll sideways at all',
  rules.overflowX === 'hidden' || rules.overflowX === 'clip',
  JSON.stringify(rules),
);
r.ok(
  'and leaves room at its edge for the colour to reach into',
  rules.reach === null || rules.padding >= rules.reach,
  JSON.stringify(rules),
);

/*
 * And every card in the list is the same size, whether it belongs to a tab or not.
 *
 * The whole point of the wash: the cards are all members of the one grid, so a tab is a colour
 * behind them rather than a box around them, and nothing has to be lengthened to compensate for
 * the height of a box. Asked for after two designs that did not line up.
 */
const sizes = JSON.parse(
  String(
    await evaluate(
      viewer.client,
      `JSON.stringify([...document.querySelectorAll('.session-card')].map((c) => {
         const b = c.getBoundingClientRect();
         return Math.round(b.height) + 'x' + Math.round(b.width);
       }))`,
    ),
  ),
);
r.ok(
  'every card in the list is the same size',
  new Set(sizes).size <= 1,
  JSON.stringify([...new Set(sizes)]),
);

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
