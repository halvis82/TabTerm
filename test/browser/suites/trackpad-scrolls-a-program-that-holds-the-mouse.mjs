// A trackpad flick over a program that holds the mouse reaches it one row at a time.
//
// Asked for by name: "scrolling in codex is completely broken ... it's slow even though i move my
// trackpad fast. it's capped." Codex 0.172 asks for the mouse, and the emulator then sends one
// wheel report per event, after damping a trackpad's small deltas to thirty percent. A flick of
// twenty rows arrived as a handful of reports.
//
// `cat -v` prints what the program receives, so the reports are counted at the program.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'cat -v\r');
await sleep(1200);

const screen = () => evaluate(client, `window.__tabterm.readScreen() ?? ''`).then(String);

// What Codex asks for: the alternate screen, every mouse event, in the SGR encoding.
await evaluate(
  client,
  `window.__tabterm.writeToPane(window.__tabterm.paneIds()[0], '\\u001b[?1049h\\u001b[?1003h\\u001b[?1006h')`,
);
await sleep(400);

const geo = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())')),
);
r.ok('the terminal has a row height to scroll by', geo.cellHeight > 0, JSON.stringify(geo));

/*
 * Ten trackpad events of thirty pixels each, the size a fast two finger flick sends.
 *
 * Three hundred pixels is that many pixels divided by a row's height in rows. The emulator on its
 * own sent at most one report per event, and fewer after damping, so anything above ten proves the
 * flick was not capped.
 */
const events = 10;
const pixels = 30;
const x = Math.round(geo.left + geo.cellWidth * 10);
const y = Math.round(geo.top + geo.cellHeight * 5);
for (let i = 0; i < events; i++) {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: 0,
    deltaY: pixels,
  });
  await sleep(20);
}

// Less one, because the row height measured here is rounded and the page's is not.
const expected = Math.floor((events * pixels) / geo.cellHeight) - 1;
const count = async () => ((await screen()).match(/\^\[\[<65;\d+;\d+M/g) ?? []).length;
await waitUntil(async () => (await count()) >= expected, 8000);
const got = await count();
r.ok(
  'every row the flick moved is reported, not one per event',
  got >= expected && got > events,
  `${String(got)} reports for ${String(expected)} rows over ${String(events)} events`,
);

await finish();
r.done();
