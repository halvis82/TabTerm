// A pane that something was launched into never gets the start screen drawn over it.
//
// Drawing it squeezes the terminal into a three row strip, and a full-screen program redraws
// itself into three rows. Whether a tab has launched anything is normally remembered in its own
// `sessionStorage`, which survives a reload and does not survive the tab being recreated, which
// is what an extension reload does to every tab.
//
// After one of those the only evidence left was the screen, and the screen is a guess that is
// wrong in exactly the case that hurts most: a program that has printed nothing yet has as few
// lines on it as a shell nobody has used. So this launches something that prints nothing at all,
// and then opens the workspace in a genuinely new tab.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openTerminal, evaluate, sleep, finish, waitFor, type, openPaneMenu } from '../helpers.mjs';
import { reporter, listTargets } from '../cdp.mjs';

const r = reporter();

const base = join(homedir(), '.cache', 'tabterm-test');
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(join(base, 'launched-')));
writeFileSync(
  join(dir, '.tabterm.json'),
  JSON.stringify({
    name: 'Quiet project',
    // Prints nothing and stays alive, which is what an agent looks like before its first output.
    // One pane, because a tab showing the start screen is a tab with exactly one.
    layout: { terminal: { command: ['sleep', '45'] } },
  }),
);

// Put the directory in the recent list the way a person does: be in it.
const first = await openTerminal();
await type(first.client, `cd ${dir}`);
await sleep(1500);

const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");
await sleep(1200);

const CHIP = `[...document.querySelectorAll('.launcher-chip.project')].find(b => b.title === ${JSON.stringify(join(dir, '.tabterm.json'))})`;
const found = await waitFor(client, `!!${CHIP}`, 12000);
r.ok('the project is offered', found);
await evaluate(client, `${CHIP}?.click()`);
await sleep(700);

// Approving opens the declared workspace in a tab of its own, so that is the one to follow.
const before = new Set(
  (await listTargets()).filter((t) => t.url.includes('terminal.html')).map((t) => t.id),
);
await evaluate(
  client,
  `[...document.querySelectorAll('.launcher-project .launcher-chip')].find(b => b.textContent.startsWith('Approve'))?.click()`,
);
await sleep(4000);
const fresh = (await listTargets()).filter(
  (t) => t.url.includes('terminal.html') && !before.has(t.id),
);
r.ok('approving opens the declared workspace in its own tab', fresh.length === 1);

const workspace = fresh[0] ? (new URL(fresh[0].url).searchParams.get('workspace') ?? '') : '';
r.ok('and that tab is on a workspace', workspace !== '', workspace);

if (workspace !== '') {
  /**
   * Opened as a genuinely new tab, which is the whole point.
   *
   * A reload keeps `sessionStorage`, so it cannot reproduce this. The service worker recreating
   * tabs after an extension reload does not, and that is when the start screen used to appear
   * over work that was already running.
   */
  const revisit = await openTerminal(`?workspace=${workspace}`);
  await sleep(3500);

  // What the daemon actually said about this pane, which is the fact the decision rests on.
  const told = String(
    await evaluate(revisit.client, `JSON.stringify(window.__tabterm?.paneFacts?.() ?? null)`),
  );
  r.ok('the daemon says the pane had something launched into it', told.includes('true'), told);

  const state = JSON.parse(
    await evaluate(
      revisit.client,
      `(() => {
         const pane = document.querySelector('.pane');
         const launcher = document.querySelector('.launcher');
         const rect = pane?.getBoundingClientRect();
         return JSON.stringify({
           launcherShown: !!launcher && !launcher.hidden,
           panelOpen: document.documentElement.classList.contains('panel-open') ||
                      document.body.classList.contains('panel-open'),
           rows: window.__tabterm?.geometry()?.rows ?? -1,
           paneHeight: rect ? Math.round(rect.height) : -1,
           windowHeight: window.innerHeight,
         });
       })()`,
    ),
  );

  r.ok(
    'a recreated tab does not draw the start screen over a pane that is running something',
    state.launcherShown === false,
    JSON.stringify(state),
  );
  r.ok(
    'and the terminal keeps the window rather than being squeezed into a strip',
    state.rows > 5,
    JSON.stringify(state),
  );
  r.ok(
    'and the pane still fills the tab',
    state.paneHeight > state.windowHeight / 2,
    JSON.stringify(state),
  );
}

/**
 * And a pane that something was launched into is not offered a marker.
 *
 * A marker is printed into the output: full width coloured bars written to the terminal itself,
 * with a prompt redrawn under them. That works on a shell, whose screen is a transcript. A
 * program that draws its own screen redraws over and around them, which was reported as two
 * magenta stripes through the middle of a conversation, belonging to nothing.
 */
if (workspace !== '') {
  const revisited = await openTerminal(`?workspace=${workspace}`);
  await sleep(3000);
  const at = JSON.parse(
    await evaluate(
      revisited.client,
      `(() => { const p = document.querySelector('.pane').getBoundingClientRect();
         return JSON.stringify({ x: Math.round(p.left + p.width / 2), y: Math.round(p.top + p.height / 2) }); })()`,
    ),
  );
  await openPaneMenu(revisited.client, at.x, at.y);
  const marker = JSON.parse(
    await evaluate(
      revisited.client,
      `(() => { const b = [...document.querySelectorAll('.term-menu-item')]
         .find(x => (x.textContent || '').trim() === 'Add a marker here');
         return JSON.stringify({ there: !!b, enabled: b ? !b.disabled : null }); })()`,
    ),
  );
  r.ok(
    'a marker is still listed on a pane running something',
    marker.there === true,
    JSON.stringify(marker),
  );
  r.ok(
    'and greyed rather than offered, since printing into it would corrupt the screen',
    marker.enabled === false,
    JSON.stringify(marker),
  );
  await evaluate(revisited.client, "document.querySelector('.term-menu')?.remove()");
}

await finish();
r.done();
