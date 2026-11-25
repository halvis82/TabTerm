// A link opens once, whoever printed it and whatever holds the mouse.
//
// Asked for by name: "when codex puts a url as output and i click it, it opens twice". Codex
// marks its links as links (OSC 8) and asks for the mouse. The emulator opened a marked link on
// any click, after a confirm dialog, and the same click was reported to Codex, which opens a link
// it is told was clicked.
//
// Each case prints one link, Command clicks it, and counts the tabs it opened, the dialogs, and
// the clicks the program was told about. `cat -v` prints those reports as text.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter, listTargets, closeTab } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await client.send('Page.enable').catch(() => {});
let dialogs = 0;
client.on((m) => {
  if (m.method !== 'Page.javascriptDialogOpening') return;
  dialogs++;
  void client.send('Page.handleJavaScriptDialog', { accept: false });
});
await type(client, 'cat -v\r');
await sleep(1200);
const geo = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())')),
);
const y = Math.round(geo.top + 2.5 * geo.cellHeight);

const meta = (type) =>
  client.send('Input.dispatchKeyEvent', {
    type,
    key: 'Meta',
    code: 'MetaLeft',
    modifiers: type === 'keyUp' ? 0 : 4,
    windowsVirtualKeyCode: 91,
  });

async function trial(label, { osc8, mouse, command }) {
  const id = `tabterm-once-${label}`;
  const url = `https://example.com/${id}`;
  const text = osc8 ? `\\u001b]8;;${url}\\u001b\\\\${url}\\u001b]8;;\\u001b\\\\` : url;
  const modes = mouse ? '\\u001b[?1003h\\u001b[?1006h' : '\\u001b[?1003l\\u001b[?1006l';
  await evaluate(
    client,
    `window.__tabterm.writeToPane(window.__tabterm.paneIds()[0], '\\u001b[2J\\u001b[H${modes}\\r\\n\\r\\n  ${text}\\r\\n')`,
  );
  await sleep(500);
  const modifiers = command ? 4 : 0;
  if (command) await meta('rawKeyDown');
  for (let col = 3; col <= 12; col++) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(geo.left + (col + 0.5) * geo.cellWidth),
      y,
      modifiers,
    });
    await sleep(40);
  }
  await sleep(800);
  const before = String(await evaluate(client, `window.__tabterm.readScreen()`));
  const x = Math.round(geo.left + 12.5 * geo.cellWidth);
  for (const kind of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type: kind,
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers,
    });
    await sleep(100);
  }
  if (command) await meta('keyUp');
  await sleep(1500);
  const tabs = (await listTargets()).filter((t) => String(t.url).includes(id));
  const after = String(await evaluate(client, `window.__tabterm.readScreen()`));
  // Button reports only: a move is reported with 32 added, and those are not clicks.
  const clicks = (s) => (s.match(/\^\[\[<[0-9];\d+;\d+[Mm]/g) ?? []).length;
  for (const t of tabs) await closeTab(t.id);
  return { tabs: tabs.length, clicks: clicks(after) - clicks(before) };
}

for (const osc8 of [false, true]) {
  for (const mouse of [false, true]) {
    const label = `${osc8 ? 'marked' : 'bare'}-${mouse ? 'mouse' : 'nomouse'}`;
    const seenDialogs = dialogs;
    const got = await trial(label, { osc8, mouse, command: true });
    r.ok(
      `a Command click on a ${osc8 ? 'marked' : 'bare'} link opens it once${mouse ? ', in a program holding the mouse' : ''}`,
      got.tabs === 1 && dialogs === seenDialogs,
      `${String(got.tabs)} tabs, ${String(dialogs - seenDialogs)} dialogs`,
    );
    if (mouse) {
      r.ok(
        `and the program is not told about that click (${label})`,
        got.clicks === 0,
        `${String(got.clicks)} click reports`,
      );
    }
  }
}

// A plain click on a marked link in a program holding the mouse is the program's click.
const seenDialogs = dialogs;
const plain = await trial('marked-plain', { osc8: true, mouse: true, command: false });
r.ok(
  'a plain click on a marked link opens nothing here and asks nothing',
  plain.tabs === 0 && dialogs === seenDialogs,
  `${String(plain.tabs)} tabs, ${String(dialogs - seenDialogs)} dialogs`,
);
r.ok('and the program is told about it', plain.clicks > 0, `${String(plain.clicks)} reports`);

await finish();
r.done();
