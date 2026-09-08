// Every operation, in a tab that has several panes.
//
// Asked for as a sweep: "do a sweep of absolutely every function and every scenario in various
// tabs with multiple panes and stuff. we've had problems there." Every fault found in a split so
// far has been an operation acting on the focused pane rather than the one it was asked about, or
// an overlay swallowing the gesture, so each check names the pane it acted on and looks at what
// happened to the others.
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

/**
 * With the start screen out of the way, which is the only state a pane menu exists in.
 *
 * A tab still showing its start screen declines a right click on the terminal under it: nothing
 * has happened in that terminal, and splitting it rearranged the layout under a panel not laid
 * out for two panes. Reaching the pane menu through a start screen is a route no person takes.
 */
await type(client, 'echo multi-pane-sweep');
await waitFor(client, `document.querySelector('.launcher')?.hidden === true`, 10000);
await sleep(600);

const panes = () => evaluate(client, `document.querySelectorAll('.pane').length`).then(Number);
const paneIds = async () =>
  JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => p.dataset.paneId ?? ''))`,
    ),
  );
const boxes = async () =>
  JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => {
         const b = p.getBoundingClientRect();
         return { id: p.dataset.paneId ?? '', x: Math.round(b.left + b.width / 2),
                  y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) };
       }))`,
    ),
  );
/** Open the menu on one pane by index, and return its entries. */
const menuOnPane = async (index) => {
  const all = await boxes();
  const at = all[index];
  if (!at) return { labels: [], id: '' };
  await openPaneMenu(client, at.x, at.y);
  const labels = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify([...document.querySelectorAll('.term-menu-item')].map((b) => (b.textContent ?? '').trim()))`,
    ),
  );
  return { labels, id: at.id };
};
const closeMenu = () => evaluate(client, "document.querySelector('.term-menu')?.remove()");
/**
 * Press a menu entry the way a hand does.
 *
 * A real press and release through the input domain rather than `element.click()`, because some
 * of these entries need a trusted gesture and a script-made click is not one: focus mode calls
 * `requestFullscreen`, the browser refuses it outside a real interaction, and the whole action
 * gives up before it maximizes anything. It reads as the entry doing nothing at all.
 */
const pressEntry = async (label) => {
  const there = await evaluate(
    client,
    `(() => { const b = [...document.querySelectorAll('.term-menu-item')]
       .find(x => (x.textContent || '').trim() === ${JSON.stringify(label)});
       return !b || b.disabled ? 'no' : 'yes'; })()`,
  );
  if (String(there) !== 'yes') return 'no';
  await realClick(client, '.term-menu-item', label);
  return 'yes';
};

/** Build a tab with three panes, each split from a named pane's own menu. */
{
  const first = await menuOnPane(0);
  r.ok(
    'a pane offers to split right',
    first.labels.includes('Split right'),
    first.labels.join(' | ').slice(0, 90),
  );
  await pressEntry('Split right');
  await waitFor(client, `document.querySelectorAll('.pane').length === 2`, 12000);
  const second = await menuOnPane(1);
  await pressEntry('Split down');
  await waitFor(client, `document.querySelectorAll('.pane').length === 3`, 12000);
  r.ok(
    'splitting twice from pane menus gives three panes',
    (await panes()) === 3,
    String(await panes()),
  );
  r.ok('and each split came from the pane it was asked on', second.id !== first.id);
  await closeMenu();
}

/** Every pane has a menu, and it names that pane rather than whichever is focused. */
{
  const all = await boxes();
  let allHaveMenus = true;
  for (let i = 0; i < all.length; i++) {
    const menu = await menuOnPane(i);
    if (!menu.labels.includes('Close session')) allHaveMenus = false;
    await closeMenu();
  }
  r.ok('every pane in a split has its own menu', allHaveMenus, `${String(all.length)} panes`);
}

/** Closing one pane closes that one, whichever it is, and leaves the others alone. */
{
  const before = await paneIds();
  const victim = before[0];
  await menuOnPane(0);
  r.ok(
    'Close session is offered on a pane that has siblings',
    String(await pressEntry('Close session')) === 'yes',
  );
  await waitFor(
    client,
    `document.querySelectorAll('.pane').length === ${String(before.length - 1)}`,
    12000,
  );
  const after = await paneIds();
  r.ok('closing takes the pane it was asked on', !after.includes(victim), `${victim} gone`);
  r.ok(
    'and leaves the others',
    before.slice(1).every((id) => after.includes(id)),
    JSON.stringify(after),
  );
  await closeMenu();
}

/** Undo brings it back. */
{
  const before = await panes();
  // The offer is a strip with the action on a button of its own inside it.
  const offered = await waitFor(
    client,
    `document.getElementById('undo-offer')?.hidden === false`,
    8000,
  );
  r.ok('closing a pane offers a way back', offered);
  const undone = await evaluate(
    client,
    `(() => { const b = document.getElementById('undo-offer-do');
       if (!b) return 'none'; b.click(); return 'yes'; })()`,
  );
  if (String(undone) === 'yes') {
    const back = await waitFor(
      client,
      `document.querySelectorAll('.pane').length === ${String(before + 1)}`,
      12000,
    );
    r.ok('undo brings a closed pane back', back, `${String(before)} -> ${String(await panes())}`);
  } else {
    r.skip('undo brings a closed pane back', 'no offer on screen');
  }
}

/** Naming a pane names that pane. */
{
  const all = await boxes();
  await menuOnPane(0);
  const named = await pressEntry('Name session');
  if (String(named) === 'yes') {
    await waitFor(client, `!!document.querySelector('.pane-label-form input')`, 8000);
    await evaluate(
      client,
      `(() => { const i = document.querySelector('.pane-label-form input');
         i.value = 'SWEEP-NAME'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    // Saved with the button: typing only previews it in this tab.
    await realClick(client, '.pane-label-form .term-menu-item', 'Save');
    await sleep(900);
    const labelled = await evaluate(
      client,
      `(() => { const p = [...document.querySelectorAll('.pane')].find(x => x.dataset.paneId === ${JSON.stringify(all[0].id)});
         return (p?.textContent ?? '').includes('SWEEP-NAME') ? 'yes' : 'no'; })()`,
    );
    r.ok('naming a pane names the pane it was asked on', String(labelled) === 'yes');
  } else {
    r.skip('naming a pane', 'not offered');
  }
  await closeMenu();
}

/** Each pane takes its own typing, and output lands only in the pane that ran it. */
{
  const all = await boxes();
  if (all.length >= 2) {
    await evaluate(
      client,
      `(() => { const p = [...document.querySelectorAll('.pane')][1];
      p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); })()`,
    );
    await sleep(400);
    await type(client, 'echo SWEEP-SECOND-PANE');
    const landed = await waitFor(
      client,
      `(window.__tabterm.readScreen(${JSON.stringify(all[1].id)}) ?? '').includes('SWEEP-SECOND-PANE')`,
      12000,
    );
    r.ok('typing goes to the focused pane', landed);
    const elsewhere = String(
      await evaluate(client, `window.__tabterm.readScreen(${JSON.stringify(all[0].id)}) ?? ''`),
    );
    r.ok('and nowhere else', !elsewhere.includes('SWEEP-SECOND-PANE'));
  } else {
    r.skip('typing goes to the focused pane', 'not enough panes');
  }
}

/** Moving a pane to its own tab takes it out of this one. */
{
  const before = await panes();
  if (before > 1) {
    await menuOnPane(0);
    const moved = await pressEntry('Move to its own tab');
    if (String(moved) === 'yes') {
      const gone = await waitFor(
        client,
        `document.querySelectorAll('.pane').length === ${String(before - 1)}`,
        15000,
      );
      r.ok(
        'moving a pane to its own tab removes it from this one',
        gone,
        `${String(before)} -> ${String(await panes())}`,
      );
    } else {
      r.skip('moving a pane to its own tab', 'not offered');
    }
    await closeMenu();
  } else {
    r.skip('moving a pane to its own tab', 'only one pane');
  }
}

/** And the panes that remain are still usable afterwards. */
{
  const all = await boxes();
  await evaluate(
    client,
    `(() => { const p = [...document.querySelectorAll('.pane')][0];
    p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); })()`,
  );
  await sleep(400);
  await type(client, 'echo SWEEP-STILL-WORKS');
  const works = await waitFor(
    client,
    `(window.__tabterm.readScreen(${JSON.stringify(all[0].id)}) ?? '').includes('SWEEP-STILL-WORKS')`,
    12000,
  );
  r.ok('a pane left behind still runs commands', works);
}

/**
 * A clear clears the pane it was asked on, and nothing else.
 *
 * The most obvious way for a split to go wrong: an operation that names a pane but acts on the
 * focused one. Every fault found in a split so far has been that shape.
 */
{
  // Two panes with different, identifiable output in them.
  await menuOnPane(0);
  await pressEntry('Split right');
  await waitFor(client, `document.querySelectorAll('.pane').length >= 2`, 12000);
  await closeMenu();
  const all = await boxes();

  const put = async (index, marker) => {
    await evaluate(
      client,
      `(() => { const p = [...document.querySelectorAll('.pane')][${String(index)}];
         p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); })()`,
    );
    await sleep(300);
    await type(client, `echo ${marker}`);
    await waitFor(
      client,
      `(window.__tabterm.readScreen(${JSON.stringify(all[index].id)}) ?? '').includes(${JSON.stringify(marker)})`,
      12000,
    );
  };
  await put(0, 'SWEEP-KEEP-ME');
  await put(1, 'SWEEP-CLEAR-ME');

  await menuOnPane(1);
  r.ok('Clear is offered on a pane', String(await pressEntry('Clear')) === 'yes');
  await closeMenu();
  const cleared = await waitFor(
    client,
    `!(window.__tabterm.readScreen(${JSON.stringify(all[1].id)}) ?? '').includes('SWEEP-CLEAR-ME')`,
    12000,
  );
  r.ok('clearing a pane clears that pane', cleared);
  const other = String(
    await evaluate(client, `window.__tabterm.readScreen(${JSON.stringify(all[0].id)}) ?? ''`),
  );
  r.ok(
    'and leaves its neighbour alone',
    other.includes('SWEEP-KEEP-ME'),
    other.slice(-60).replace(/\s+/g, ' '),
  );

  // And the undo for that clear puts back the pane it cleared, not the other one.
  const undoUp = await waitFor(
    client,
    `document.getElementById('clear-undo')?.hidden === false`,
    8000,
  );
  if (undoUp) {
    /**
     * Click it, and make sure the click landed before judging what it did.
     *
     * This failed once in about six full runs, always under load, and the two things it could
     * mean are not the same: the product failed to restore the pane, or the pointer missed a
     * button that is redrawn on a timer and can move out from under it. The offer hiding is proof
     * the click was received, so a click that is not received is retried, and one that is
     * received is judged on the product's behaviour with no retry at all.
     */
    let landed = false;
    for (let attempt = 0; attempt < 2 && !landed; attempt += 1) {
      await realClick(client, '#clear-undo');
      landed = await waitFor(
        client,
        `document.getElementById('clear-undo')?.hidden !== false`,
        4000,
      );
    }
    r.ok('the undo offer takes the click', landed);
    const restored = await waitFor(
      client,
      `(window.__tabterm.readScreen(${JSON.stringify(all[1].id)}) ?? '').includes('SWEEP-CLEAR-ME')`,
      12000,
    );
    r.ok('and undoing that clear restores that pane', restored);
  } else {
    r.skip('and undoing that clear restores that pane', 'no offer');
  }
}

/**
 * Focus mode takes one pane full screen and gives the layout back.
 *
 * Checked by geometry rather than by a class: what matters is that one pane has the window and
 * that the others are where they were afterwards.
 */
{
  const before = await boxes();
  if (before.length >= 2) {
    await menuOnPane(0);
    const entered = await pressEntry('Fullscreen focus mode');
    await closeMenu();
    if (String(entered) === 'yes') {
      await sleep(1200);
      /**
       * Asked of the layout rather than of the pixels.
       *
       * Going full screen needs a real user gesture, and a synthetic click is not one: the
       * browser refuses and the window keeps its size. What is under test is that the layout
       * maximizes one pane and can put the rest back, which it records itself.
       */
      const maximized = String(await evaluate(client, `window.__tabterm.maximizedPane() ?? ''`));
      r.ok(
        'focus mode maximizes one pane',
        maximized !== '',
        `maximized=${maximized} panes=${String(await panes())} entered=${String(entered)}`,
      );
      const showing = JSON.parse(
        await evaluate(
          client,
          `JSON.stringify([...document.querySelectorAll('.pane')].map((p) => ({
             id: p.dataset.paneId ?? '',
             shown: p.getBoundingClientRect().width > 4 })))`,
        ),
      );
      r.ok(
        'and only that one is on screen',
        showing.filter((p) => p.shown).length === 1,
        JSON.stringify(showing),
      );
      await evaluate(client, `void window.__tabterm.leaveFocusMode()`);
      await sleep(1200);
      const after = await boxes();
      r.ok(
        'and leaving it puts every pane back',
        after.length === before.length,
        `${String(before.length)} -> ${String(after.length)}`,
      );
    } else {
      r.skip('focus mode gives one pane the window', 'not offered');
    }
  } else {
    r.skip('focus mode gives one pane the window', 'not enough panes');
  }
}

/** Markers belong to the pane they were added in. */
{
  const all = await boxes();
  if (all.length >= 2) {
    await menuOnPane(1);
    const added = await pressEntry('Add a marker here');
    await closeMenu();
    if (String(added) === 'yes') {
      // A marker is named before it exists, the same as anywhere else it is added.
      await waitFor(client, `!!document.querySelector('.pane-label-input')`, 8000);
      await evaluate(
        client,
        `(() => { const i = document.querySelector('.pane-label-input');
           i.value = 'SWEEP-MARKER'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await realClick(client, '.pane-label-form .term-menu-item', 'Save');
      await sleep(1500);
      /**
       * Read off each pane's screen, not off the rail beside it.
       *
       * A marker is printed into the session's output, and that is the thing that must land in
       * one pane and not the others. The pips on the rail are a second view of the same fact and
       * they are built from the buffer on their own schedule, so counting them asks a question
       * about when the rail was last rebuilt rather than about where the marker went.
       */
      const ids = await paneIds();
      const counts = [];
      for (const id of ids) {
        const screen = String(
          await evaluate(client, `window.__tabterm.readScreen(${JSON.stringify(id)}) ?? ''`),
        );
        counts.push(screen.includes('SWEEP-MARKER') ? 1 : 0);
      }
      const total = counts.reduce((a, b) => a + b, 0);
      r.ok(
        'a marker is added to one pane only',
        total >= 1 && counts.filter((c) => c > 0).length === 1,
        `${JSON.stringify(counts)} facts=${String(await evaluate(client, `JSON.stringify(window.__tabterm.paneFacts())`))}`,
      );
    } else {
      r.skip('a marker is added to one pane only', 'not offered');
    }
  } else {
    r.skip('a marker is added to one pane only', 'not enough panes');
  }
}

await finish();
r.done();
