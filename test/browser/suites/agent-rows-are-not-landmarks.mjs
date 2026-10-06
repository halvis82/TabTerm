// An agent's input box is not a landmark, and the response that replaces it is not painted.
//
// Claude Code draws its prompt as a full-width row of 48;2;55;55;55, which is what a landmark
// looked like to the page. The row was painted with a band anchored to its buffer line, the
// resync that moves bands was put off by every render and an agent's spinner renders every
// hundred milliseconds, so the band stayed on the line while the response scrolled into it.
// Reported as output text under the input box wearing its gray, in Claude Code and Codex, gone
// on refresh. A landmark's padding is concealed now and nothing else is one.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  type,
  realClick,
  openPaneMenu,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
import { fileURLToPath } from 'node:url';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
const fixture = fileURLToPath(new URL('../fixtures/agent-input-row.sh', import.meta.url));
await type(client, `sh ${fixture}`);

const seen = { landmarks: 0, bands: 0, samples: 0 };
const started = Date.now();
while (Date.now() - started < 7000) {
  const state = JSON.parse(
    await evaluate(
      client,
      `JSON.stringify({ landmarks: window.__tabterm.markers().length, bands: document.querySelectorAll('.xterm-decoration').length })`,
    ),
  );
  seen.samples++;
  seen.landmarks = Math.max(seen.landmarks, state.landmarks);
  seen.bands = Math.max(seen.bands, state.bands);
  await sleep(150);
}
r.ok(
  "an agent's gray input row is never taken for a landmark, before or during its spinner",
  seen.landmarks === 0,
  JSON.stringify(seen),
);
r.ok('and no band is ever painted on the screen', seen.bands === 0, JSON.stringify(seen));
r.ok('the probe actually watched the whole redraw', seen.samples >= 30, String(seen.samples));

// A real landmark is still found, through the daemon, with its concealed padding.
await waitFor(client, "(window.__tabterm.readScreen() ?? '').includes('working 39')", 10000);
await sleep(1500);
await openPaneMenu(client, 60, 60);
await sleep(250);
await realClick(client, '.term-menu-item', 'Add a marker here');
await sleep(500);
await evaluate(client, "document.querySelector('.pane-label-input').value = 'after the agent'");
await realClick(client, '.pane-label-form .term-menu-item', 'Save');
r.ok(
  'while a landmark TabTerm printed is still found',
  await waitFor(client, 'window.__tabterm.markers().length === 1', 8000),
  await evaluate(client, 'JSON.stringify(window.__tabterm.markers())'),
);
r.ok(
  'and painted as one band, three rows tall',
  await waitFor(client, "document.querySelectorAll('.xterm-decoration').length === 3", 5000),
  await evaluate(client, "String(document.querySelectorAll('.xterm-decoration').length)"),
);

await finish();
r.done();
