// Closing and killing a pane from its own right-click menu, more than once, on any pane.
//
// Reported as not working in a split at all, or working exactly once. Every entry in that menu
// targets the pane that was clicked by focusing it first, so the thing to check is not that the
// entry runs but that it runs on the pane that was actually clicked, repeatedly.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  realClick,
  openPaneMenu,
  type,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.pane')");

const panes = () => evaluate(client, `document.querySelectorAll('.pane').length`);
const paneBoxes = async () =>
  JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => {
         const b = p.getBoundingClientRect();
         return { id: p.dataset.paneId ?? '', x: Math.round(b.left + b.width / 2),
                  y: Math.round(b.top + b.height / 2) };
       }))`,
    ),
  );

/** Split from the pane's own menu, which is the surface under test anyway. */
const splitFromMenu = async (label) => {
  const boxes = await paneBoxes();
  const at = boxes[boxes.length - 1];
  await openPaneMenu(client, at.x, at.y);
  await realClick(client, '.term-menu-item', label);
  await sleep(1600);
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");
};

// Three panes, so there is something to close twice and something left over.
await splitFromMenu('Split right');
await splitFromMenu('Split down');
r.ok('three panes to work with', Number(await panes()) === 3, String(await panes()));

/**
 * Closed from the menu of a pane that is not the focused one.
 *
 * That is the case that was reported, and the one where focusing first has to actually happen
 * before the entry runs, or the close lands on whichever pane happened to be focused.
 */
for (const round of [1, 2]) {
  const boxes = await paneBoxes();
  const before = boxes.length;
  // The first pane in document order, which is not the one a split leaves focused.
  const victim = boxes[0];
  await openPaneMenu(client, victim.x, victim.y);
  const shown = Number(await evaluate(client, `document.querySelectorAll('.term-menu').length`));
  r.ok(`round ${round}: the menu opens on that pane`, shown === 1, String(shown));

  const clicked = await realClick(client, '.term-menu-item', 'Close session');
  r.ok(`round ${round}: Close session is there and can be pressed`, clicked !== false);
  await sleep(1800);

  const after = Number(await panes());
  r.ok(
    `round ${round}: closing from the menu really closes that pane`,
    after === before - 1,
    `${String(before)} -> ${String(after)}`,
  );
  r.ok(
    `round ${round}: and the pane that went is the one that was clicked`,
    !(await paneBoxes()).some((p) => p.id === victim.id),
    victim.id,
  );
  await evaluate(client, "document.querySelector('.term-menu')?.remove()");
}

/**
 * And killing a session, which is a different entry doing a different thing.
 *
 * One pane left by now, where `Close session` means the tab. Kill ends the process instead, so
 * it is checked on its own rather than by closing everything.
 */
{
  await splitFromMenu('Split right');
  const boxes = await paneBoxes();
  r.ok('a fresh split to kill in', boxes.length === 2, String(boxes.length));
  await openPaneMenu(client, boxes[0].x, boxes[0].y);
  const labels = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map((b) => (b.textContent ?? '').trim()))`,
    ),
  );
  r.ok(
    'Kill session is offered',
    labels.some((l) => l.includes('Kill session')),
    labels.join(' | '),
  );
  const enabled = await evaluate(
    client,
    `[...document.querySelectorAll('.term-menu-item')].find((b) => (b.textContent ?? '').includes('Kill session'))?.disabled === false`,
  );
  r.ok('and is not greyed out on a pane that has a session', String(enabled) === 'true');
  const sessionsBefore = String(
    await evaluate(client, `JSON.stringify(window.__tabterm.paneFacts().map((p) => p.paneId))`),
  );
  const killed = await realClick(client, '.term-menu-item', 'Kill session');
  r.ok('the kill entry was actually pressed', killed !== false, sessionsBefore);
  // Waited for, not slept past: ending a process escalates through SIGHUP and SIGTERM before
  // SIGKILL, so a shell that runs its exit hooks takes as long as it takes.
  const gone = await waitFor(client, `document.querySelectorAll('.pane').length === 1`, 15000);
  const detail = String(
    await evaluate(
      client,
      `JSON.stringify({ elements: document.querySelectorAll('.pane').length,
                        host: window.__tabterm.paneFacts().length,
                        withSession: [...document.querySelectorAll('.pane')].map(p => (p.dataset.paneId||'').slice(0,6)) })`,
    ),
  );
  r.ok('killing the session takes the pane with it', gone, detail);
}

/**
 * And the same thing happening on its own, for comparison.
 *
 * A shell told to exit ends the same way a killed one does, so if one removes the pane and the
 * other does not, the difference is in the path and not in the idea.
 */
{
  await splitFromMenu('Split right');
  const before = Number(await panes());
  await evaluate(client, `document.querySelector('.pane.focused .xterm-helper-textarea')?.focus()`);
  await type(client, 'exit');
  const wentOnItsOwn = await waitFor(
    client,
    `document.querySelectorAll('.pane').length === ${String(before - 1)}`,
    15000,
  );
  r.ok(
    'a shell that exits takes its pane with it',
    wentOnItsOwn,
    `${String(before)} -> ${String(await panes())}`,
  );
}

await finish();
r.done();
