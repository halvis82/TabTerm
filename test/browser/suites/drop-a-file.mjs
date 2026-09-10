// A file dropped on the window arrives at the prompt as a path.
//
// Chrome hands a page the bytes and the name of a dropped file and withholds where it came from,
// so there is no path to type. The daemon writes a copy and answers with the path of that. Without
// any of this Chrome does its own thing with a dropped file, which is to leave the page and open
// the file in the tab, taking the terminal off the screen to do it.
import { openTerminal, evaluate, sleep, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(1200);

/**
 * Drag a real file over the window, in the browser rather than through the driver.
 *
 * CDP can drive a drag from outside the page, but not one that starts in the operating system,
 * which is the only kind that carries a file. So the events are built and dispatched with a
 * DataTransfer of our own, which is what the page actually reads.
 */
const drag = (type, withFile) => `(() => {
  const dt = new DataTransfer();
  ${withFile ? "dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'my photo (1).png', { type: 'image/png' }));" : "dt.setData('text/plain', 'not a file');"}
  window.dispatchEvent(new DragEvent(${JSON.stringify(type)}, { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
})()`;

const overlayShown = () =>
  evaluate(
    client,
    `(() => { const d = document.getElementById('drop'); return !!d && !d.hidden; })()`,
  );

r.ok('nothing is showing before a drag', !(await overlayShown()), 'overlay was already up');

await evaluate(client, drag('dragenter', true));
await sleep(200);
r.ok('the window lights up when a file is dragged over it', await overlayShown(), 'no overlay');

// A pane inside the window is a child element, and dragleave fires on every boundary crossed.
await evaluate(client, drag('dragenter', true));
await evaluate(client, drag('dragleave', true));
await sleep(200);
r.ok(
  'and stays lit while the pointer crosses what is inside it',
  await overlayShown(),
  'overlay flickered off',
);

await evaluate(client, drag('dragleave', true));
await sleep(200);
r.ok('and goes out when the drag leaves', !(await overlayShown()), 'overlay stayed up');

// Dragged text is taken too, and the window says which of the two it is about to do.
await evaluate(client, drag('dragenter', false));
await sleep(200);
const textLabel = String(
  await evaluate(client, `document.querySelector('#drop span')?.textContent ?? ''`),
);
r.ok('dragged text lights the window up as well', await overlayShown(), 'no overlay for text');
r.ok('and it says the text is going to the prompt', /text/i.test(textLabel), textLabel);
await evaluate(client, drag('dragleave', false));
await sleep(200);

await evaluate(client, drag('dragenter', true));
await sleep(150);
await evaluate(client, drag('drop', true));
await sleep(2500);

r.ok(
  'the overlay goes out on the drop',
  !(await overlayShown()),
  'overlay stayed up after the drop',
);

const screen = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));
const line =
  screen
    .split(String.fromCharCode(10))
    .filter((l) => l.trim() !== '')
    .slice(-1)[0] ?? '';
// The name had a space and brackets in it, so what lands has to be quoted and rebuilt.
r.ok('a path is staged at the prompt', /dropped\//.test(line), line.slice(-90));
r.ok(
  'the name is rebuilt out of characters a shell can take',
  line.includes('my-photo-1-.png'),
  line.slice(-90),
);
r.ok('and it is staged rather than run', !screen.includes('command not found'), line.slice(-90));

// Dragged text pastes as text. Asked for as "why wouldn't that work".
await evaluate(
  client,
  `(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'some dragged words');
    for (const type of ['dragenter', 'drop']) {
      window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    return true;
  })()`,
);
await sleep(1200);
const afterText = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));
r.ok(
  'dragged text lands at the prompt',
  afterText.includes('some dragged words'),
  afterText
    .split(String.fromCharCode(10))
    .filter((l) => l.trim())
    .slice(-1)[0] ?? '',
);
r.ok('and it is staged rather than run', !afterText.includes('command not found'), 'it ran');

await finish();
r.done();
