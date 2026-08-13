// A cloned repository can declare a workspace. Nothing about it runs without a decision.
import { openTerminal, type, evaluate, sleep, finish } from '../helpers.mjs';
import { reporter, connect } from '../cdp.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const r = reporter();

// Not a temp directory: those are deliberately kept out of recent folders, so a fixture under
// tmp never reaches the launcher and this suite would be testing nothing.
const base = join(homedir(), '.cache', 'tabterm-test');
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(join(base, 'project-')));
writeFileSync(
  join(dir, '.tabterm.json'),
  JSON.stringify({
    name: 'Demo project',
    layout: {
      direction: 'horizontal',
      children: [{ terminal: { command: ['echo', 'PROJECT-LEFT'] } }, { terminal: {} }],
    },
  }),
);

// Put the directory in the recent list the way a person does: be in it.
const first = await openTerminal();
await type(first.client, `cd ${dir}`);
await sleep(1500);

const { client } = await openTerminal();
await sleep(1500);

const CHIP = `[...document.querySelectorAll('.launcher-chip.project')].find(b => b.title === ${JSON.stringify(join(dir, '.tabterm.json'))})`;
const chip = JSON.parse(
  await evaluate(
    client,
    `(() => { const b = ${CHIP}; return JSON.stringify({ found: !!b, label: b?.textContent, unreviewed: b?.classList.contains('unreviewed') }); })()`,
  ),
);
r.ok('a declared project is noticed', chip.found === true, String(chip.label));
r.ok('and marked as unreviewed', chip.unreviewed === true);

await evaluate(client, `${CHIP}?.click()`);
await sleep(500);

const panel = JSON.parse(
  await evaluate(
    client,
    `(() => { const p = document.querySelector('.launcher-project'); return JSON.stringify({
      shown: !!p,
      commands: p ? [...p.querySelectorAll('.launcher-project-commands li')].map(li => li.textContent) : [],
      buttons: p ? [...p.querySelectorAll('.launcher-chip')].map(b => b.textContent) : [],
    }); })()`,
  ),
);
r.ok('it asks before doing anything', panel.shown === true);
r.ok(
  'and shows every declared command verbatim',
  JSON.stringify(panel.commands) === JSON.stringify(['echo PROJECT-LEFT', '(shell)']),
  JSON.stringify(panel.commands),
);
r.ok('offering refusal as well as approval', panel.buttons.length === 2, panel.buttons.join(' | '));

const before = new Set(
  (await (await fetch('http://127.0.0.1:9223/json/list')).json())
    .filter((t) => t.url.includes('terminal.html'))
    .map((t) => t.id),
);
await evaluate(
  client,
  `[...document.querySelectorAll('.launcher-project .launcher-chip')].find(b => b.textContent.startsWith('Approve'))?.click()`,
);
await sleep(3500);

const fresh = (await (await fetch('http://127.0.0.1:9223/json/list')).json()).filter(
  (t) => t.url.includes('terminal.html') && !before.has(t.id),
);
r.ok('approving opens the declared workspace', fresh.length === 1);

if (fresh[0]) {
  const opened = connect(fresh[0].webSocketDebuggerUrl);
  await opened.ready;
  await opened.send('Runtime.enable');
  await sleep(4000);
  const panes = await evaluate(opened, `document.querySelectorAll('.pane').length`);
  r.ok('with the layout it declared', Number(panes) === 2, `${String(panes)} panes`);
  const screen = await evaluate(
    opened,
    `window.__tabterm?.readScreen(window.__tabterm.paneIds()[0]) ?? ''`,
  );
  r.ok('and the declared command ran', String(screen).includes('PROJECT-LEFT'));
}

await finish();
r.done();
