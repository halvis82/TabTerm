// Naming a session renames the tab at once, rather than when the daemon says so.
//
// Reported as "tab titles don't always update smoothly when i set a session name". The daemon owns
// the layout and echoes a new name back, and the title was composed only from what had come back,
// while the pane itself drew the name as it was typed. Everything on the screen said the new name
// and the tab strip said the old one for as long as the round trip took.
//
// A tab holding one pane, because that is where a name reaches the front of the title. With
// several panes a name is one of several and only fills in for a status.
//
// Measured in milliseconds from the press, because the fault is a delay rather than a wrong
// answer: with the round trip it is a message each way, without it is a frame.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  realClick,
  openPaneMenu,
  waitFor,
  waitUntil,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
// Use the pane first, the way a person would, so the start screen is gone and the right click
// reaches the terminal underneath.
await type(client, 'echo one-pane-here\r');
await waitUntil(
  async () =>
    String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).includes('one-pane-here'),
  15000,
);

r.ok(
  'one pane in this tab',
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')))
    .length === 1,
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneSessions())')),
);
const before = String(await evaluate(client, 'document.title'));
r.ok('and it is not called by any name yet', !before.includes('build watch'), before);

await openPaneMenu(client);
await realClick(client, '.term-menu-item', 'Name session');
await sleep(500);
await evaluate(client, "document.querySelector('.pane-label-input').value = 'build watch'");
await evaluate(
  client,
  `document.querySelector('.pane-label-input').dispatchEvent(new Event('input', { bubbles: true }))`,
);

/*
 * Pressed and read in the same breath, deliberately.
 *
 * A delay of one round trip against a local daemon is a few milliseconds, so a stopwatch here
 * would pass either way and prove nothing. This reads the title in the same task as the press
 * instead: nothing can have come back from the daemon yet, because that needs a turn of the event
 * loop at the very least. Either the page named the tab itself or the title is still the old one.
 */
const titleAtOnce = String(
  await evaluate(
    client,
    `(() => {
       const save = [...document.querySelectorAll('.pane-label-form .term-menu-item')]
         .find((b) => (b.textContent ?? '').trim() === 'Save');
       if (!save) return 'no Save button';
       for (const type of ['mousedown', 'mouseup', 'click']) {
         save.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
       }
       return document.title;
     })()`,
  ),
);
r.ok(
  'the tab takes the name in the same breath as the press',
  titleAtOnce.includes('build watch'),
  titleAtOnce,
);

// And the name is at the front, which is the half of a title that survives being cut off.
r.ok(
  'with the name in front of it',
  String(await evaluate(client, 'document.title')).startsWith('build watch'),
  String(await evaluate(client, 'document.title')),
);

/*
 * The echo says the same thing.
 *
 * Writing the name into the layout the page is holding is optimism, and optimism is wrong if the
 * daemon comes back with something else. A second later, it still says the name.
 */
await sleep(2000);
r.ok(
  'and still says it once the daemon has answered',
  String(await evaluate(client, 'document.title')).includes('build watch'),
  String(await evaluate(client, 'document.title')),
);

await finish();
r.done();
