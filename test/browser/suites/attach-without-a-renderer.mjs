// Reattaching without a renderer must not move a terminal.
//
// The two renderers disagree about the width of a cell: the DOM one reports the font's advance and
// the WebGL one snaps it down to whole device pixels. Read out of a real machine's log, 7.5 from
// the WebGL renderer in every one of 6512 measurements against 7.82 to 7.84 from the DOM one. Four
// percent, which is 120 columns against 125.
//
// Attaching is exactly when the WebGL one may not be there yet: every tab reattaches at once when
// the extension reloads, and they contend for a capped number of GPU contexts. A pane that lost
// that race measured with the DOM renderer, the daemon applied it, and the pane corrected itself a
// moment later. Two resizes for one reload, and an agent redraws its whole interface for each,
// which is the scrambled transcript reported three times. Visible in that log as `attach 120x45`
// followed by `resize-pane 125x45`.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo RENDERER-RACE\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('RENDERER-RACE')`, 20000);
await sleep(1500);

/** What the daemon says it has actually applied, which is the only size that matters. */
const applied = async () =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.appliedSizes())')));

const settled = (await applied()).at(-1);
r.ok(
  'the session settled on a size',
  typeof settled === 'string' && settled.includes('x'),
  settled,
);

/*
 * Reloaded with the renderer refused, which is what losing the race for a context looks like.
 *
 * The flag is set before the reload and read by the page as it comes up, so the panes this tab
 * rebuilds measure with the DOM renderer, exactly as they do on a machine where every tab is
 * fighting for a context at once.
 */
await evaluate(client, 'sessionStorage.setItem("tabterm.blockRenderer", "1")');
await client.send('Page.reload');
await waitFor(client, 'window.__tabterm?.paneIds().length === 1', 25000);
await sleep(3000);

const after = await applied();
const asks = String(
  await evaluate(
    client,
    `JSON.stringify(window.__tabterm.paneIds().flatMap((id) => window.__tabterm.sizeAsksFor(id).map((a) => a.why + ':' + a.cols)))`,
  ),
);
r.ok(
  'and the session was not moved by a measurement taken without one',
  after.every((size) => size === settled),
  `settled ${String(settled)}, then ${JSON.stringify(after)}; asks ${asks}`,
);

/*
 * And once a renderer arrives the pane follows the window again, which is the half that must not
 * be broken by the half above. Refusing a measurement forever would be a pane that never resizes.
 */
await evaluate(client, 'sessionStorage.removeItem("tabterm.blockRenderer")');
await evaluate(client, 'window.__tabterm.blockRendererForTest(false)');
await client.send('Emulation.setDeviceMetricsOverride', {
  width: 900,
  height: 700,
  deviceScaleFactor: 0,
  mobile: false,
});
const followed = await waitUntil(async () => {
  const now = await applied();
  return now.length > 0 && now.at(-1) !== settled;
}, 20000);
r.ok('and follows the window once it has one', followed, JSON.stringify(await applied()));
await client.send('Emulation.clearDeviceMetricsOverride');

await finish();
r.done();
