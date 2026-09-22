// The start screen is searched as a page, because that is what it is.
//
// The find bar exists because a terminal is a canvas with nothing in the page to read. On the start
// screen the opposite holds: the previews, the paths and the names are all text. The bar was still
// searching the strip of terminal along the bottom, which is empty, so a word plainly on screen in
// a session's preview answered "no matches".
//
// Asked for as a way to find a session by what is in it, since the preview is the only place some
// sessions are recognisable at all.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  press,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

// A session with a word in it that nothing else on the page has.
const work = await openTerminal();
await waitFor(work.client, "document.querySelector('.launcher-input')");
await type(work.client, 'echo zqxbanana\r');
await waitFor(work.client, `(window.__tabterm.readScreen() ?? '').includes('zqxbanana')`, 20000);
await sleep(1500);

// Read from another tab's start screen, which is where somebody looks for a session they left.
const viewer = await openTerminal();
await waitFor(viewer.client, "document.querySelector('.launcher-input')");
const showing = await waitUntil(
  async () =>
    String(await evaluate(viewer.client, 'document.body.textContent')).includes('zqxbanana'),
  20000,
);
r.ok('the word is on the start screen, in a preview', showing);

/*
 * Command+F, pressed for real. The bar is opened by the page's own shortcut, so a check that
 * opened it by calling something would not be checking the thing that was broken.
 */
await press(viewer.client, 'f', 'KeyF', 4, 70, { focus: 'none' });
await sleep(600);
const opened = Number(
  await evaluate(viewer.client, `document.querySelectorAll('#find:not([hidden])').length`),
);
r.ok('the find bar opens', opened === 1);

await evaluate(
  viewer.client,
  `(() => { const box = document.getElementById('find-input');
     box.value = 'zqxbanana';
     box.dispatchEvent(new Event('input', { bubbles: true })); })()`,
);
/*
 * Waited for, not slept at. The list redraws whenever a session anywhere changes, and a redraw
 * takes the marks with it until the search puts them back. Seven hundred milliseconds was long
 * enough until a full run was busy enough that it was not.
 */
const marks = async () =>
  Number(await evaluate(viewer.client, `document.querySelectorAll('mark.find-hit').length`));
const found = await waitUntil(async () => (await marks()) > 0, 10000);
r.ok('and the word in the preview is found', found, `${String(await marks())} marks`);

const count = String(
  await evaluate(viewer.client, `document.getElementById('find-count')?.textContent ?? ''`),
);
r.ok('and the bar says how many, rather than "no matches"', /of/.test(count), count);

const current = Number(
  await evaluate(viewer.client, `document.querySelectorAll('mark.find-hit.is-current').length`),
);
r.ok('and one of them is the current one', current === 1);

/*
 * And closing it puts the page back exactly as it was, with no marks left behind in the text.
 */
await press(viewer.client, 'Escape', 'Escape', 0, 27, { focus: 'none' });
await sleep(600);
const left = Number(
  await evaluate(viewer.client, `document.querySelectorAll('mark.find-hit').length`),
);
r.ok('and closing it leaves no marks behind', left === 0, `${String(left)} left`);

await finish();
r.done();
