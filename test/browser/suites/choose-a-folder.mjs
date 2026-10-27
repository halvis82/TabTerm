// Command Shift G in a folder box opens the macOS Choose a Folder window at the folder typed, and
// the folder chosen goes into the box. Asked for for every folder box: the start screen's, and an
// empty pane's in a split. The test daemon answers for the window with /usr.
import { openTerminal, evaluate, sleep, finish, waitFor, waitUntil } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

const press = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type,
      key: 'g',
      code: 'KeyG',
      windowsVirtualKeyCode: 71,
      modifiers: 4 | 8,
    });
  }
};

// The start screen's box.
await evaluate(client, "document.querySelector('.launcher .launcher-input')?.focus()");
await press();
r.ok(
  'on the start screen, the chosen folder goes into the box',
  await waitUntil(
    async () =>
      String(
        await evaluate(client, "document.querySelector('.launcher .launcher-input')?.value"),
      ) === '/usr/',
    5000,
  ),
  String(await evaluate(client, "document.querySelector('.launcher .launcher-input')?.value")),
);
r.ok(
  'and the box lists what is in it',
  await waitUntil(
    async () =>
      String(await evaluate(client, "document.querySelector('.launcher')?.textContent")).includes(
        'bin',
      ),
    5000,
  ),
);

// An empty pane's box, after a split.
await evaluate(client, "document.querySelector('.launcher .launcher-input').value = ''");
await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, "document.querySelector('.pane-chooser .launcher-input')", 10000);
await sleep(500);
await evaluate(client, "document.querySelector('.pane-chooser .launcher-input')?.focus()");
await press();
r.ok(
  'in a new pane, the chosen folder goes into its box',
  await waitUntil(
    async () =>
      String(
        await evaluate(client, "document.querySelector('.pane-chooser .launcher-input')?.value"),
      ) === '/usr/',
    5000,
  ),
  String(await evaluate(client, "document.querySelector('.pane-chooser .launcher-input')?.value")),
);
await finish();
r.done();
