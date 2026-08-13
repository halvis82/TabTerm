// The terminal has to actually fill the tab.
//
// It did not, for a single-pane workspace, which is every new tab. `.pane` is a flex item and
// its parent was a block, so it resolved to zero height and the tab looked simply dark. Splits
// were unaffected because a split inserts a flex wrapper, and every existing suite split a pane
// before looking at anything -- so all of them passed while the common case was broken.
import { openTerminal, evaluate, sleep, finish } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
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

await finish();
r.done();
