// A program that asks for the mouse is told where it was clicked.
//
// Asked for by name: "in claude in iterm, you can click places. you can click somewhere in the
// text input box for example and the cursor goes where you click ... can we enable that in
// tabterm". A terminal cannot move an agent's cursor itself; what it can do is report the click,
// which is what the agent acts on. So this checks the report, at the session, for a real click.
//
// `cat -v` prints control characters as text, so what the program receives is read from the
// program rather than inferred from the page.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'cat -v\r');
await sleep(1200);

const screen = () => evaluate(client, `window.__tabterm.readScreen() ?? ''`).then(String);

/*
 * The program asks for the mouse, in the encoding every current program uses.
 *
 * Written as output, because that is how a program asks: `?1000h` is "tell me about clicks" and
 * `?1006h` is "in the encoding that survives a terminal wider than 223 columns". Sent through the
 * pane rather than through the shell so the bytes are exactly these and nothing else.
 */
await evaluate(
  client,
  `window.__tabterm.writeToPane(window.__tabterm.paneIds()[0], '\\u001b[?1000h\\u001b[?1006h')`,
);
await sleep(400);

const asked = await evaluate(
  client,
  `(() => {
     const geo = window.__tabterm.geometry();
     return JSON.stringify(geo);
   })()`,
);
r.ok('the terminal has a box to click in', String(asked).includes('cellWidth'), String(asked));

const geo = JSON.parse(String(asked));
// A few cells in and a couple of rows down, so the report carries a column and a row worth reading.
const x = Math.round(geo.left + geo.cellWidth * 8 + geo.cellWidth / 2);
const y = Math.round(geo.top + geo.cellHeight * 3 + geo.cellHeight / 2);

for (const type_ of ['mousePressed', 'mouseReleased']) {
  await client.send('Input.dispatchMouseEvent', {
    type: type_,
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await sleep(120);
}

/*
 * What arrives is `ESC [ < 0 ; col ; row M`, which `cat -v` prints as `^[[<0;9;4M`. The column and
 * the row are one-based, so the ninth column and the fourth row are the cell pressed above.
 */
const reported = await waitUntil(async () => /\^\[\[<0;\d+;\d+M/.test(await screen()), 8000);
r.ok('a click reaches the program as a mouse report', reported, (await screen()).slice(-120));

const where = /\^\[\[<0;(\d+);(\d+)M/.exec(await screen());
r.ok(
  'and it names the cell that was pressed',
  where !== null && Number(where[1]) === 9 && Number(where[2]) === 4,
  JSON.stringify(where?.slice(1)),
);

/*
 * And a click into a pane that does not have the keyboard is reported too.
 *
 * That is the case somebody actually has: the pointer goes to a terminal they were not typing in,
 * and the click that brings it forward is also the click they meant for the program. A terminal
 * that spends it on focusing leaves the agent's cursor where it was, which reads as clicking
 * doing nothing.
 */
await evaluate(client, `document.querySelector('.launcher-input')?.focus()`);
await sleep(300);
const before = (await screen()).length;

for (const kind of ['mousePressed', 'mouseReleased']) {
  await client.send('Input.dispatchMouseEvent', {
    type: kind,
    x: Math.round(geo.left + geo.cellWidth * 20 + geo.cellWidth / 2),
    y: Math.round(geo.top + geo.cellHeight * 5 + geo.cellHeight / 2),
    button: 'left',
    clickCount: 1,
  });
  await sleep(120);
}

const second = await waitUntil(async () => (await screen()).length > before, 8000);
const latest = /\^\[\[<0;(\d+);(\d+)M/g;
const all = [...(await screen()).matchAll(latest)];
const last = all[all.length - 1];
r.ok(
  'a click into a pane that was not focused is reported as well',
  second && last !== undefined && Number(last[1]) === 21 && Number(last[2]) === 6,
  JSON.stringify(last?.slice(1)),
);

/*
 * And a click moves the cursor in a program that never asked for the mouse.
 *
 * Which is the case that was reported: Claude does not turn mouse reporting on at all, measured by
 * reading what it sets on a fresh start, so no report will ever move its caret. What moves it is
 * arrow keys, one per column, which is what a person would press. See `click-to-move.ts`.
 *
 * Checked with the mouse handed back first, then typed into so there is a line with a caret in the
 * middle of it. `cat -v` shows what arrives, so `^[[D` is an arrow this end sent.
 */
await evaluate(
  client,
  `window.__tabterm.writeToPane(window.__tabterm.paneIds()[0], '\u001b[?1000l\u001b[?1006l')`,
);
await sleep(400);
await type(client, 'abcdefghij', { submit: false });
await sleep(600);

const geoNow = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())')),
);

// Four columns to the left of where the caret is, on the same row as the caret.
const caretRow = (await evaluate(client, `window.__tabterm.cursorCell().row`)) ?? 0;
const caretColumn = Number(await evaluate(client, `window.__tabterm.cursorCell().column`));
const target = Math.max(0, caretColumn - 4);
for (const kind of ['mousePressed', 'mouseReleased']) {
  await client.send('Input.dispatchMouseEvent', {
    type: kind,
    x: Math.round(geoNow.left + geoNow.cellWidth * target + geoNow.cellWidth / 2),
    y: Math.round(geoNow.top + geoNow.cellHeight * Number(caretRow) + geoNow.cellHeight / 2),
    button: 'left',
    clickCount: 1,
  });
  await sleep(120);
}

const moved = await waitUntil(
  async () => ((await screen()).match(/\^\[\[D/g) ?? []).length >= 4,
  8000,
);
r.ok(
  'a click on the line being typed moves the cursor there',
  moved,
  `${String(((await screen()).match(/\^\[\[D/g) ?? []).length)} arrows arrived`,
);

await finish();
r.done();
