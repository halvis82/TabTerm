// A file dropped on the window arrives at the prompt as a path.
//
// Chrome hands a page the bytes and the name of a dropped file and withholds where it came from,
// so there is no path to type. The daemon writes a copy and answers with the path of that. Without
// any of this Chrome does its own thing with a dropped file, which is to leave the page and open
// the file in the tab, taking the terminal off the screen to do it.
import { openTerminal, evaluate, sleep, finish, waitFor, waitUntil, type } from '../helpers.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/*
 * A drop on the launcher's path box belongs to the box, not to the window.
 *
 * Reported: dropping a path there put it in the box and staged the same text at the prompt of the
 * pane behind the start screen, where it waited to be carried along by the next thing typed. What
 * came out was `/Users/halvis82cd ~/Downloads/`.
 */
const onTheBox = await evaluate(
  client,
  `(() => {
    const input = document.querySelector('.launcher-input');
    if (!input) return JSON.stringify({ value: 'no path box' });
    const before = window.__tabterm.readScreen();
    const dt = new DataTransfer();
    dt.setData('text/plain', '/Users/somebody/a-dropped-path');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      input.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    return JSON.stringify({ value: input.value });
  })()`,
);
await sleep(900);
const parsed = JSON.parse(String(onTheBox));
r.ok('the path box takes the drop', parsed.value.includes('a-dropped-path'), String(parsed.value));
const afterBox = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""'));
r.ok(
  'and the terminal behind it is left alone',
  !afterBox.includes('a-dropped-path'),
  afterBox
    .split(String.fromCharCode(10))
    .filter((l) => l.trim())
    .slice(-1)[0] ?? '',
);

/**
 * A file that is already on this machine gives its path, and is never read.
 *
 * Reported with a 298 MB archive dragged out of Downloads: the page read all of it, encoded it,
 * and the tab lost its WebGL context and filled its terminal with parse errors. "it should just
 * paste the path to it regardless of whether it's a claude or terminal or whatever. it shouldn't
 * do anything else."
 *
 * The file here is made in the session's own directory, given a size past what a copy would ever
 * be allowed, and dropped with no bytes behind it at all: `new File([], name)` carries a name and
 * a size and nothing to read. If anything tries to read it, what reaches the prompt is not the
 * path.
 */
{
  /*
   * A tab of its own, because the drops above leave a path staged at the prompt and anything
   * typed after one is appended to it rather than run.
   */
  const fresh = await openTerminal();
  await waitFor(fresh.client, "document.querySelector('.launcher-input')");
  const where = mkdtempSync(join(tmpdir(), 'tt-drop-'));
  const name = 'a big archive.zip';
  writeFileSync(join(where, name), 'not actually big, but really there');
  await type(fresh.client, `cd ${JSON.stringify(where)}\r`);
  await sleep(1500);

  const huge = `(() => {
    const dt = new DataTransfer();
    const file = new File([], ${JSON.stringify(name)}, { type: 'application/zip' });
    Object.defineProperty(file, 'size', { value: 298 * 1024 * 1024 });
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`;
  await evaluate(fresh.client, huge);

  /*
   * Matched without the newlines, and on the tail of the path rather than all of it.
   *
   * A path this long wraps across the terminal, and macOS answers the same directory as both
   * `/var/...` and `/private/var/...`. What has to be true is that the folder it is in and the
   * name it has both arrived, as one quoted word.
   */
  const wanted = `${where.split('/').pop() ?? ''}/${name}`;
  const flat = async () =>
    String(await evaluate(fresh.client, 'window.__tabterm.readScreen() ?? ""')).replace(/\n/g, '');
  const staged = await waitUntil(async () => (await flat()).includes(wanted), 15000);
  r.ok(
    'a file already on this machine arrives as its own path, whatever its size',
    staged,
    (await flat()).slice(-160),
  );
  r.ok(
    'and no copy of it was taken, which is what reading a 298 MB archive would have meant',
    !(await flat()).includes('/dropped/'),
    (await flat()).slice(-160),
  );
  r.ok(
    'and the terminal is still a terminal',
    (await evaluate(fresh.client, 'window.__tabterm.paneIds().length')) === 1,
  );
}

await finish();
r.done();
