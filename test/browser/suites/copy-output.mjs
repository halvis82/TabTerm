// Copy output on a finished command, and the glow on a pane that finished.
//
// Asked for as: a Copy output button that captures the whole output whatever its formatting and
// wrapping, appears only once the command is truly done, never for an agent, with a limit on
// lines set in Settings. And: the pane that finished glows, only with the flash setting on, and
// goes the moment anything is done on the tab.
import {
  openTerminal,
  evaluate,
  waitFor,
  sleep,
  finish,
  type,
  openPaneMenu,
  realClick,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo copy-output-suite');
await waitFor(client, "document.querySelector('.launcher')?.hidden === true", 10000);
await sleep(600);

const paneId = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
)[0];
const blocks = async () =>
  JSON.parse(
    String(
      await evaluate(
        client,
        `JSON.stringify(window.__tabterm.outputBlocks(${JSON.stringify(paneId)}))`,
      ),
    ),
  );
const hasBlock = (needle) =>
  waitFor(
    client,
    `window.__tabterm.outputBlocks(${JSON.stringify(paneId)}).some((b) => b.text.includes(${JSON.stringify(needle)}))`,
    8000,
  );
const button = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.outputCopy())')));
async function pointAt(needle) {
  const p = JSON.parse(
    String(
      await evaluate(
        client,
        `JSON.stringify(window.__tabterm.rowPoint(${JSON.stringify(paneId)}, ${JSON.stringify(needle)}))`,
      ),
    ),
  );
  if (!p) return false;
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  return true;
}

// The whole output, blank line and all.
await type(client, "printf 'alpha-out\\n\\nbeta-out\\n'");
r.ok('a finished command has its output', await hasBlock('alpha-out'));
const first = (await blocks()).find((b) => b.text.includes('alpha-out'));
r.ok(
  'exactly as printed, blank line included',
  first?.text === 'alpha-out\n\nbeta-out',
  JSON.stringify(first),
);

// A line longer than the pane is one line, not the rows it was wrapped onto.
await type(client, "printf 'w%.0s' {1..400}; echo");
r.ok('a long line has its output', await hasBlock('wwwwwwwwww'));
const wide = (await blocks()).find((b) => b.text.startsWith('wwww'));
r.ok(
  'and a wrapped line comes back as one line',
  wide?.text === 'w'.repeat(400),
  String(wide?.text.length),
);

// Still running is not finished, however quiet it is.
const before = (await blocks()).length;
await type(client, 'sleep 3; echo late-out');
await sleep(1200);
r.ok('a command still running has no button yet', (await blocks()).length === before);
r.ok('until the shell comes back', await hasBlock('late-out'));

// An agent's output is its own interface.
await type(
  client,
  "d=$(mktemp -d) && printf '#!/bin/sh\\necho agent-out\\n' > $d/claude && chmod +x $d/claude",
);
await sleep(800);
await type(client, '$d/claude');
await sleep(1500);
r.ok(
  'an agent gets no button',
  !(await blocks()).some((b) => b.text.includes('agent-out')),
  JSON.stringify(await blocks()),
);

// Hovering the output offers it; clicking copies it.
await type(client, 'clear');
await sleep(500);
await type(client, "printf 'hover-me\\n'");
await hasBlock('hover-me');
await sleep(300);
r.ok('the output is on screen to point at', await pointAt('hover-me'));
r.ok(
  'pointing at it offers Copy output',
  await waitFor(
    client,
    "window.__tabterm.outputCopy().shown && window.__tabterm.outputCopy().label === 'Copy output'",
    3000,
  ),
  JSON.stringify(await button()),
);
r.ok('with its whole output', (await button()).text === 'hover-me');
await realClick(client, '.output-copy');
r.ok(
  'and a press copies it',
  await waitFor(client, 'window.__tabterm.outputCopy().copied === true', 3000),
);

// Longer than the limit: the newest lines, and the button says so.
await evaluate(client, "chrome.storage.local.set({ 'tabterm.copyOutputLines': 100 })");
await sleep(300);
await type(client, 'clear');
await sleep(500);
await type(client, 'seq 1 250');
await hasBlock('\n250');
const long = (await blocks()).find((b) => b.text.endsWith('\n250'));
r.ok(
  'past the limit it keeps the newest lines',
  long?.lines === 100 && long?.partial === true && long.text.startsWith('151\n'),
  JSON.stringify({ lines: long?.lines, start: long?.text.slice(0, 8) }),
);
await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
await sleep(800);
await pointAt('240');
r.ok(
  'and the button says how many',
  await waitFor(client, "window.__tabterm.outputCopy().label === 'Copy last 100 lines'", 3000),
  JSON.stringify(await button()),
);
await evaluate(client, "chrome.storage.local.remove('tabterm.copyOutputLines')");

// The glow: nothing with the setting off.
const glowing = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.glowingPanes())')));
await type(client, 'true');
await sleep(1200);
r.ok('with the flash setting off, nothing glows', (await glowing()).length === 0);

await openPaneMenu(client, 60, 60);
await sleep(250);
await realClick(client, '.term-menu-item', 'Flash the tab when a command finishes');
await sleep(300);

await type(client, 'sleep 1');
r.ok(
  'with it on, the pane that finished glows green',
  await waitFor(
    client,
    'window.__tabterm.glowingPanes().length === 1 && !window.__tabterm.glowingPanes()[0].failed',
    5000,
  ),
  JSON.stringify(await glowing()),
);
await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft' });
r.ok(
  'and any key takes it away',
  await waitFor(client, 'window.__tabterm.glowingPanes().length === 0', 3000),
);

await type(client, 'sleep 1; false');
r.ok(
  'a failed command glows red',
  await waitFor(client, 'window.__tabterm.glowingPanes()[0]?.failed === true', 5000),
  JSON.stringify(await glowing()),
);
await sleep(700);
await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 200 });
await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 220, y: 210 });
r.ok(
  'and moving the pointer takes it away too',
  await waitFor(client, 'window.__tabterm.glowingPanes().length === 0', 3000),
);

await openPaneMenu(client, 60, 60);
await sleep(250);
await realClick(client, '.term-menu-item', 'Flash the tab when a command finishes');

await finish();
r.done();
