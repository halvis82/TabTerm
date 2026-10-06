// Splitting a pane hands the keyboard to the pane it made.
//
// Reported as the split not going to the new session: the pane appeared beside the one that was
// split, the keyboard stayed where it was, and whatever was typed next went into the old shell.
// Somebody who splits wants the new pane, so the tab that asked for the split focuses it. Only
// that tab: a mirror of the workspace in another tab sees the same layout change and must not
// have its keyboard moved by somebody else's split.
import {
  openTerminal,
  evaluate,
  readScreen,
  sleep,
  type,
  finish,
  realClick,
  openPaneMenu,
  waitFor,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo BEFORE-THE-SPLIT\r');
await sleep(1200);

const focused = () => evaluate(client, 'window.__tabterm.focusedPane()');
const panes = () =>
  evaluate(
    client,
    "JSON.stringify([...document.querySelectorAll('.pane')].map((p) => p.dataset.paneId))",
  ).then((s) => JSON.parse(s));
/** Whether the keyboard is in the pane the ring is on, which is the whole of what focus means. */
const keyboardInFocusedPane = () =>
  evaluate(
    client,
    "document.querySelector('.pane.focused')?.contains(document.activeElement) === true",
  );

const first = await focused();
await openPaneMenu(client, 200, 300);
await realClick(client, '.term-menu-item', 'Split right');
await waitFor(client, "document.querySelectorAll('.pane').length === 2", 12000);
await sleep(600);

const afterRight = await focused();
r.ok(
  'split right focuses the pane it made',
  afterRight !== '' && afterRight !== first && (await panes()).includes(afterRight),
  `${first} -> ${afterRight}`,
);
r.ok('and the keyboard goes with the ring', await keyboardInFocusedPane());

// Typing lands in the new pane, which is the thing the report was about.
const MARK = `TYPED-INTO-THE-NEW-PANE-${String(Date.now()).slice(-5)}`;
await type(client, `echo ${MARK}\r`);
const landed = await waitFor(
  client,
  `(window.__tabterm.readScreen(${JSON.stringify(afterRight)}) ?? '').includes(${JSON.stringify(MARK)})`,
  12000,
);
r.ok('what is typed next runs in the new pane', landed);
r.ok('and not in the one that was split', !(await readScreen(client, first)).includes(MARK));

// The same from the keyboard, downwards, with the new pane as the source this time.
await openPaneMenu(client, 200, 300);
await realClick(client, '.term-menu-item', 'Split down');
await waitFor(client, "document.querySelectorAll('.pane').length === 3", 12000);
await sleep(600);
const afterDown = await focused();
r.ok(
  'split down focuses the pane it made',
  afterDown !== '' && afterDown !== afterRight && afterDown !== first,
  `${afterRight} -> ${afterDown}`,
);
r.ok('and the keyboard goes with the ring again', await keyboardInFocusedPane());

await finish();
r.done();
