// Option click puts vim's cursor where the click was, as it does in iTerm.
//
// Asked: "find out if vi (vim) is clickable in iterm and see if we're missing that functionality".
// In iTerm, Option click moves the cursor in vim with or without vim's mouse, by sending arrow
// keys. Here vim runs without any configuration, so it has not asked for the mouse at all, and the
// file it saves says where the cursor really was.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const r = reporter();
const dir = mkdtempSync(join(tmpdir(), 'tabterm-vim-'));
const file = join(dir, 'lines.txt');
writeFileSync(file, 'line zero here\nline one here\nline two here\nline three here\n');

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

/**
 * Open the file in vim, click on the t of "two", insert an X there, save, and read the file.
 *
 * Option click needs nothing from vim. A plain click needs vim to have asked for the mouse, which
 * `set mouse=a` does, exactly as in iTerm.
 */
async function clickInVim(label, vimArgs, modifiers) {
  writeFileSync(file, 'line zero here\nline one here\nline two here\nline three here\n');
  await type(client, `clear; vim -u NONE -N ${vimArgs} ${file}`);
  await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('line three here')`, 15000);
  await sleep(800);
  const geo = JSON.parse(
    String(await evaluate(client, 'JSON.stringify(window.__tabterm.geometry())')),
  );
  const rows = String(await evaluate(client, 'window.__tabterm.readScreen() ?? ""')).split('\n');
  const twoRow = rows.findIndex((l) => l.startsWith('line two here'));
  const x = Math.round(geo.left + geo.cellWidth * 5 + geo.cellWidth / 2);
  const y = Math.round(geo.top + geo.cellHeight * twoRow + geo.cellHeight / 2);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  for (const kind of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type: kind,
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers,
    });
    await sleep(120);
  }
  await sleep(600);
  await type(client, 'iX', { submit: false });
  await sleep(200);
  await type(client, '\u001b:wq', { submit: true });
  await sleep(1500);
  const saved = readFileSync(file, 'utf8').split('\n');
  r.ok(
    label,
    saved[2] === 'line Xtwo here' && saved[0] === 'line zero here' && saved[1] === 'line one here',
    saved.join(' | '),
  );
}

// 1 is Alt, which is Option.
await clickInVim(
  'Option click puts the cursor where the click was, in a vim without the mouse',
  '',
  1,
);
await clickInVim(
  'a plain click does too, once vim has the mouse with set mouse=a',
  "-c 'set mouse=a'",
  0,
);

await finish();
r.done();
