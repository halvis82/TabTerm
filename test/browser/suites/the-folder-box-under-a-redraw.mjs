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

/**
 * And the folders themselves are still there after a redraw.
 *
 * A redraw rebuilds the whole screen, so the box is built empty and what was typed is put back
 * afterwards. The list of folders under it was not put back at all: the new box has no list beside
 * it, and nothing asks for one, because asking is skipped when the directory has not changed and it
 * has not. So the folders went and stayed gone until somebody typed another character.
 *
 * Which is worse than it sounds, because the screen redraws whenever anything happens anywhere in
 * TabTerm. A session starting in another tab is enough. Somebody halfway into choosing a folder
 * loses the list they were reading, and `..` with it, so there is no way back up except by editing
 * the path by hand.
 *
 * Driven through `render` rather than by asking the daemon to refresh, deliberately: a refresh that
 * learns nothing draws nothing, so the fault this exists for is invisible to it. That is why it went
 * unnoticed here while `folder-picker` failed a full run, where the screen really does redraw.
 */
await typeIn('Documents/');
const folders = async () =>
  Number(await evaluate(client, `document.querySelectorAll('.launcher-completion').length`));
const upRow = async () =>
  Boolean(
    await evaluate(
      client,
      `[...document.querySelectorAll('.launcher-completion')].some((c) => c.textContent === '..')`,
    ),
  );
r.ok('there are folders listed to begin with', (await folders()) > 0, String(await folders()));
r.ok('including the way back up', await upRow());

await evaluate(client, 'window.__tabterm.redrawStartScreen()');
await sleep(600);
r.ok(
  'the folders are still listed after the screen is redrawn',
  (await folders()) > 0,
  `${String(await folders())} listed`,
);
r.ok('and the way back up is still there', await upRow());

/*
 * What this suite does not check, and why.
 *
 * "A refresh that learns nothing draws nothing" belongs to `repeated-answers`, as a unit check.
 * A full run shares one daemon between suites, so the state genuinely changes while this is
 * watching: another suite starting a session really is news, and a screen that redrew for it was
 * right to. Asserting it here failed a run twice with the product doing the right thing, which is
 * a check teaching the wrong lesson.
 *
 * What is left here is the part only a browser can answer: that a press lands and that typing
 * survives, with the screen redrawing under both.
 */
await evaluate(client, 'clearInterval(window.__ttStorm)');

await finish();
r.done();
