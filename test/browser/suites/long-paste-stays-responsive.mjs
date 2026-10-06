// A long paste must never take the page down.
//
// Reported as the extension dying: fifty two letters pasted twelve times into a narrow pane made
// every TabTerm tab unresponsive, a reload did not bring them back, and opening the same session
// again did it again because the line was still on the screen. The scan that resolves paths as
// they are printed stepped to the row after the last one a logical line covered, a logical line
// is capped at twelve rows, and a line longer than that was read as its first twelve rows from
// every row in it, so the step landed on the same row every time.
//
// Measured rather than assumed: the page is asked a trivial question before and after each
// paste, and the answer has to keep coming.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'echo start');
await waitFor(client, "document.querySelector('.launcher')?.hidden === true", 10000);
await sleep(500);

const timed = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
/** Whether the page answers a trivial question within a bound. */
const answers = async (ms = 3000) => {
  try {
    await timed(evaluate(client, '1 + 1'), ms);
    return true;
  } catch {
    return false;
  }
};
const paste = (n) =>
  evaluate(
    client,
    `(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      const dt = new DataTransfer();
      dt.setData('text/plain', 'j'.repeat(${String(n)}));
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return 'sent';
    })()`,
  );

r.ok('the page answers before anything is pasted', await answers());
for (const n of [624, 2000, 8000]) {
  let sent = '';
  try {
    sent = await timed(paste(n), 5000);
  } catch (e) {
    sent = String(e);
  }
  r.ok(`a paste of ${String(n)} characters is taken`, sent === 'sent', sent);
  await sleep(1500);
  r.ok(`and the page still answers afterwards`, await answers(), `${String(n)} characters`);
  await sleep(1500);
  r.ok(
    `and keeps answering while the line sits on the screen`,
    await answers(),
    `${String(n)} characters`,
  );
}
r.ok(
  'the pasted line reached the shell',
  (await evaluate(client, 'window.__tabterm.readScreen()')).includes('j'.repeat(50)),
);

await finish();
r.done();
