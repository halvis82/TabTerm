// The terminal has to actually fill the tab.
//
// It did not, for a single-pane workspace, which is every new tab. `.pane` is a flex item and
// its parent was a block, so it resolved to zero height and the tab looked simply dark. Splits
// were unaffected because a split inserts a flex wrapper, and every existing suite split a pane
// before looking at anything -- so all of them passed while the common case was broken.
import {
  openTerminal,
  evaluate,
  readScreen,
  sleep,
  type,
  finish,
  boxOf,
  waitUntil,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

/**
 * Wait for the start screen rather than guessing at how long it takes.
 *
 * A fixed sleep is enough when this suite runs alone and not when fifteen tabs are already open,
 * which is exactly the difference between passing here and failing in a full run.
 */
// eslint-disable-next-line no-unused-vars
async function launcherReady(client) {
  for (let i = 0; i < 40; i++) {
    if (await evaluate(client, `!!document.querySelector('.launcher-input')`)) return true;
    await sleep(250);
  }
  return false;
}

const { client } = await openTerminal();
await sleep(800);

const geometry = () =>
  evaluate(
    client,
    `(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          top: Math.round(rect.top),
        };
      };
      return JSON.stringify({
        viewport: { w: window.innerWidth, h: window.innerHeight },
        pane: box('.pane'),
        launcherOpen: !document.querySelector('.launcher')?.hidden,
        term: box('.xterm'),
        screen: box('.xterm-screen'),
        rows: window.__tabterm ? null : null,
      });
    })()`,
  ).then((s) => JSON.parse(s));

const g = await geometry();

r.ok('a single pane exists', g.pane !== null);

// While the panel is up the terminal is a strip at the bottom, because that is where a
// terminal's input belongs and the panel occupies the space above that has no output in it yet.
r.ok(
  'the terminal sits at the bottom while the panel is open',
  g.pane !== null && g.pane.top + g.pane.h > g.viewport.h - 30,
  `bottom edge at ${String((g.pane?.top ?? 0) + (g.pane?.h ?? 0))} of ${String(g.viewport.h)}`,
);
r.ok(
  'and still spans the full width',
  g.pane ? g.pane.w / g.viewport.w > 0.9 : false,
  `${String(g.pane?.w ?? 0)}px of ${String(g.viewport.w)}px`,
);
r.ok(
  'the rendered screen matches the terminal',
  g.screen !== null && g.term !== null && Math.abs(g.screen.h - g.term.h) < 30,
  `screen ${String(g.screen?.h ?? 0)} vs term ${String(g.term?.h ?? 0)}`,
);

// And it stays right after the panel goes away, which is when the user first sees it.
await evaluate(client, `document.querySelector('.pane.focused .xterm-helper-textarea')?.focus()`);
for (const ch of 'echo LAYOUT') {
  await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
  await sleep(4);
}
await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r' });
await sleep(1500);

const after = await geometry();
r.ok(
  'and still fills the tab once the panel is dismissed',
  after.term ? after.term.h / after.viewport.h > 0.8 : false,
  `${String(after.term?.h ?? 0)}px`,
);

/**
 * A layout chosen on the start screen is built in that tab.
 *
 * It used to open a second tab and leave this one on the menu, which read as the layout having
 * failed. The panes were there, in a tab nobody was looking at.
 */
for (const [chip, wanted] of [
  ['Split in 2', 2],
  ['1 + 2', 3],
  ['4 panes', 4],
]) {
  const fresh = await openTerminal();
  await sleep(3500);
  await evaluate(
    fresh.client,
    `(() => { document.querySelector('.launcher-input').value = '~'; })()`,
  );
  await evaluate(
    fresh.client,
    `[...document.querySelectorAll('.launcher-chip')].find((c) => c.firstChild?.textContent === ${JSON.stringify(chip)})?.click()`,
  );
  // Panes arrive over a socket, so wait for the count rather than for a duration.
  let panes = 0;
  for (let i = 0; i < 40; i++) {
    panes = Number(await evaluate(fresh.client, `window.__tabterm?.paneIds().length ?? 0`));
    if (panes >= wanted) break;
    await sleep(300);
  }
  r.ok(
    `${chip} builds ${String(wanted)} panes in the tab it was chosen from`,
    panes === wanted,
    `${String(panes)} panes`,
  );
}

/**
 * Open lands in the folder that was typed.
 *
 * The path was shell-quoted whole, and a quoted tilde is a literal character rather than home,
 * so `cd '~/Documents'` failed for a folder plainly there. Almost every path typed into that box
 * starts with a tilde, so the box appeared not to work at all.
 */
const opener = await openTerminal();
await sleep(3500);
await evaluate(
  opener.client,
  `(() => { document.querySelector('.launcher-input').value = '~/Documents'; })()`,
);
await evaluate(
  opener.client,
  `[...document.querySelectorAll('.launcher-chip')].find((c) => c.firstChild?.textContent === 'Open')?.click()`,
);
await sleep(2500);
await type(opener.client, 'pwd');
await sleep(1800);
const landed = String(await readScreen(opener.client));
r.ok(
  'Open changes to the folder that was typed, tilde and all',
  landed.includes('/Documents') && !/no such file/i.test(landed),
  landed.split('\n').filter(Boolean).slice(-2)[0] ?? '',
);

/**
 * A divider stays exactly where it was put, across a refresh.
 *
 * A dragged divider is applied to the DOM straight away and reported to the daemon once on
 * release, and the daemon is what a refresh reads the layout back from. So there are two numbers
 * that have to agree, and nothing on screen says when they do not: the panes settle at whatever
 * the second one is. A ratio stored to fewer digits than it was dragged to would move the divider
 * a little every time the tab was reopened, which is the kind of drift nobody can report because
 * no single refresh looks wrong.
 *
 * Measured in pixels rather than compared as a stored number, because pixels are what a person
 * sees and they would also catch the divider being re-derived from something other than the ratio.
 */
{
  const dragged = await openTerminal();
  await waitUntil(
    async () => !!(await evaluate(dragged.client, `!!document.querySelector('.launcher-input')`)),
    30000,
  );
  await evaluate(
    dragged.client,
    `(() => { document.querySelector('.launcher-input').value = '~'; })()`,
  );
  await evaluate(
    dragged.client,
    `[...document.querySelectorAll('.launcher-chip')].find((c) => c.firstChild?.textContent === 'Split in 2')?.click()`,
  );
  const split = await waitUntil(
    async () =>
      Number(await evaluate(dragged.client, `window.__tabterm?.paneIds().length ?? 0`)) === 2,
    30000,
  );
  r.ok('two panes to drag between', split);

  const paneWidth = async () =>
    Math.round(
      Number(
        await evaluate(
          dragged.client,
          `document.querySelector('.pane')?.getBoundingClientRect().width ?? 0`,
        ),
      ),
    );

  const bar = await boxOf(dragged.client, '.divider');
  const before = await paneWidth();
  // A real pointer, so the capture the divider takes on pointerdown behaves as it does for a hand.
  const midY = bar.y + bar.height / 2;
  await dragged.client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: bar.x + bar.width / 2,
    y: midY,
    button: 'left',
    clickCount: 1,
  });
  const target = Math.round(bar.x - 140);
  for (const x of [bar.x - 40, bar.x - 90, target]) {
    await dragged.client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: midY,
      button: 'left',
    });
    await sleep(60);
  }
  await dragged.client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target,
    y: midY,
    button: 'left',
    clickCount: 1,
  });
  await sleep(400);
  const afterDrag = await paneWidth();
  r.ok(
    'the drag moved the divider',
    afterDrag > 0 && Math.abs(afterDrag - before) > 40,
    `${String(before)} -> ${String(afterDrag)}`,
  );

  await evaluate(dragged.client, 'location.reload()');
  await waitUntil(
    async () =>
      Number(await evaluate(dragged.client, `window.__tabterm?.paneIds().length ?? 0`)) === 2,
    40000,
  );
  // The panes come back over a socket, so the width is worth reading once it has stopped moving.
  let settled = 0;
  await waitUntil(async () => {
    const now = await paneWidth();
    if (now > 0 && now === settled) return true;
    settled = now;
    return false;
  }, 20000);
  r.ok(
    'and the refreshed tab puts it back in the same place, to the pixel',
    Math.abs(settled - afterDrag) <= 1,
    `dragged to ${String(afterDrag)}, came back ${String(settled)}`,
  );
}

await finish();
r.done();
