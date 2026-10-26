// Dictation, and any input method, shows its unfinished text where it will go, wrapped inside the
// pane, and never as one line running off both sides of it.
//
// Reported with a photo: macOS dictation's live text ran along the bottom row of a Claude pane and
// off its edges, where Claude's own box would have wrapped it. Dictation shows words as marked
// text, the same composition an input method uses, and the terminal drew that in a strip that
// never wraps.
import { openTerminal, evaluate, sleep, type, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await type(client, 'clear\r');
await sleep(600);
// To the last row, where an agent's input sits, so wrapping cannot simply run on downwards.
await type(client, "printf '\\n%.0s' $(seq 1 60)\r");
await sleep(800);
await evaluate(client, "document.querySelector('.xterm-helper-textarea')?.focus()");

const SPOKEN =
  'also while typing this prompt i noticed something weird when I use the built in dictation it lets me talk and the text shows up while I am still talking but it runs off the line instead of wrapping like it should';
await client.send('Input.imeSetComposition', {
  text: SPOKEN,
  selectionStart: SPOKEN.length,
  selectionEnd: SPOKEN.length,
});
await sleep(400);
const box = () =>
  evaluate(
    client,
    `(() => {
       const v = [...document.querySelectorAll('.composition-view')].find((e) => e.classList.contains('active'));
       const s = v?.closest('.xterm')?.querySelector('.xterm-screen');
       if (!v || !s) return 'none';
       const a = v.getBoundingClientRect(), b = s.getBoundingClientRect();
       const row = b.height / (window.__tabterm.geometry()?.rows || 24);
       return JSON.stringify({ width: a.width, room: b.right - a.left, hidden: v.scrollHeight - v.clientHeight, left: a.left - b.left, right: b.right - a.right, top: a.top - b.top, bottom: b.bottom - a.bottom, lines: Math.round(a.height / row), text: v.textContent.length });
     })()`,
  ).then((s) => (s === 'none' ? null : JSON.parse(String(s))));
const shown = await box();
if (process.env.TT_SHOT_DIR) {
  await client.send('Page.bringToFront');
  await sleep(400);
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(
    `${process.env.TT_SHOT_DIR}/dictation.png`,
    Buffer.from(data, 'base64'),
  );
}
r.ok(
  'the words being spoken are shown',
  shown !== null && shown.text === SPOKEN.length,
  JSON.stringify(shown),
);
r.ok(
  'wrapped across the pane from the cursor, a few lines for a sentence or two',
  shown !== null &&
    shown.lines >= 2 &&
    shown.width >= shown.room - 2 &&
    shown.lines <= 6 &&
    shown.hidden <= 1,
  JSON.stringify(shown),
);
r.ok(
  'and inside the pane on every side',
  shown !== null && shown.left >= -1 && shown.right >= -1 && shown.top >= -1 && shown.bottom >= -1,
  JSON.stringify(shown),
);

// Finished speaking: the words go to the program, and the strip goes.
const seenBefore = Number(await evaluate(client, 'window.__tabterm.inputSeen()'));
// As dictation ends: the marked text is committed in place, and the composition ends.
await evaluate(
  client,
  `(() => {
     const t = document.querySelector('.xterm-helper-textarea');
     t.dispatchEvent(new CompositionEvent('compositionend', { data: ${JSON.stringify(SPOKEN)}, bubbles: true }));
   })()`,
);
await sleep(500);
r.ok(
  'and once finished, the words reach the program',
  await waitUntil(
    async () =>
      String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'))
        .replace(/\s+/g, '')
        .includes('instead of wrapping like it should'.replace(/\s+/g, '')),
    5000,
  ),
);
r.ok(
  'sent once, exactly as spoken',
  Number(await evaluate(client, 'window.__tabterm.inputSeen()')) - seenBefore === SPOKEN.length,
);
r.ok('and nothing is left over the terminal', (await box()) === null);
await type(client, '\x15');
await finish();
r.done();
