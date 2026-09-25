// The folder box keeps up with a start screen that is redrawing under it.
//
// The screen redraws whenever anything happens anywhere in TabTerm, which during a busy minute is
// several times a second. Everything on it is rebuilt each time, so a press has to survive the row
// it landed on being replaced, and what somebody has typed has to survive being restored from the
// version captured before their press.
//
// Driven with a redraw every sixty milliseconds, which is harder than anything a real machine
// does, and pressed through the element rather than at a point: this is about what happens to the
// state, and `folder-picker` already covers pressing the row with a real mouse.
import { openTerminal, evaluate, sleep, waitFor, finish } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(1200);

const box = () => evaluate(client, "document.querySelector('.launcher-input').value");
const typeIn = async (text) => {
  await evaluate(
    client,
    `(() => { const i = document.querySelector('.launcher-input'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await sleep(1000);
};

await typeIn('Documents/');
r.ok(
  'the box holds a folder to start from',
  String(await box()) === 'Documents/',
  String(await box()),
);

await evaluate(
  client,
  'window.__ttStorm = setInterval(() => window.__tabterm.refreshStartScreen(), 60)',
);
await sleep(300);

/*
 * Pressed, and the box read in the same breath.
 *
 * Reading it later cannot tell a press that never landed from a value that was put back after it
 * did, and those are different faults with different fixes.
 */
const notes = [];
let wentUp = false;
for (let attempt = 1; attempt <= 4 && !wentUp; attempt++) {
  const straightAfter = String(
    await evaluate(
      client,
      `(() => {
         const up = [...document.querySelectorAll('.launcher-completion')].find((b) => b.textContent === '..');
         if (!up) return 'no-row';
         up.click();
         return JSON.stringify(document.querySelector('.launcher-input').value);
       })()`,
    ),
  );
  await sleep(500);
  const later = String(await box());
  notes.push(`${String(attempt)}: at once ${straightAfter}, later ${JSON.stringify(later)}`);
  wentUp = later === '';
}

r.ok('pressing `..` while the screen redraws goes up, and stays up', wentUp, notes.join(' | '));

// And typing survives it too, which is the same rule seen from the other side.
await typeIn('Documents/');
await sleep(700);
r.ok(
  'and what was typed is still there after a dozen redraws',
  String(await box()) === 'Documents/',
  String(await box()),
);

/*
 * And a refresh that learns nothing draws nothing.
 *
 * This is the fix underneath the two checks above rather than a separate feature: the daemon
 * re-sends what it knows whenever anything anywhere might have changed it, and every one of those
 * used to replace every control on the screen, taking with it any press that was landing.
 *
 * Asked of the drawing log rather than by watching one row. A row can be replaced for an honest
 * reason: in a full run other suites are starting sessions in the same daemon, and a list of what
 * is running really has changed. What must not happen is a drawing prompted by a state that says
 * what the last one said, and the log names what prompted each one.
 */
await evaluate(client, 'clearInterval(window.__ttStorm)');
await sleep(800);
const drawingsBefore = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.renderLog())')),
).length;
for (let i = 0; i < 12; i++) {
  await evaluate(client, 'window.__tabterm.refreshStartScreen()');
  await sleep(120);
}
await sleep(500);
const since = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.renderLog())')),
).slice(drawingsBefore);
const forState = since.filter((drawing) => (drawing.since ?? []).includes('state'));
r.ok(
  'twelve refreshes that learn nothing draw nothing for the state',
  forState.length === 0,
  `${String(since.length)} drawings, ${String(forState.length)} of them for the state: ${JSON.stringify(since.map((d) => d.since))}`,
);

await finish();
r.done();
