// The terminal has to actually fill the tab.
//
// It did not, for a single-pane workspace, which is every new tab. `.pane` is a flex item and
// its parent was a block, so it resolved to zero height and the tab looked simply dark. Splits
// were unaffected because a split inserts a flex wrapper, and every existing suite split a pane
// before looking at anything -- so all of them passed while the common case was broken.
import { openTerminal, evaluate, readScreen, sleep, type, finish } from '../helpers.mjs';
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

await finish();
r.done();
