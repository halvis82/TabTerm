// A start screen shows what is true now, not what was true when it was opened.
//
// Asked for directly: "if something happens in another homescreen tab where we open one of the
// running now sessions ... then that should be reflected on another homescreen session without
// having to be refreshed. or if a new folder is made, that should be reflected in the folder
// picker stuff too. just all of that. but light weight."
//
// Light weight is the interesting half. The daemon says only that the answer changed; the pages
// showing the start screen ask for what they need, and every other page ignores it.
import { openTerminal, evaluate, sleep, finish, waitFor, type } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();

// Two start screens, side by side.
const watcher = await openTerminal();
await waitFor(watcher.client, "document.querySelector('.launcher-input')");
const worker = await openTerminal();
await waitFor(worker.client, "document.querySelector('.launcher-input')");
await sleep(1500);

const runningIn = (c) =>
  evaluate(c, `document.querySelectorAll('.session-card').length`).then(Number);

const before = await runningIn(watcher.client);

/**
 * Work in the other tab, which is what the first tab has to notice.
 *
 * A command run in one tab turns that shell into a session worth offering, which is a change to
 * the list the other tab is showing.
 */
await type(worker.client, 'echo LIVE-HOMESCREEN');
const noticed = await waitFor(
  watcher.client,
  `document.querySelectorAll('.session-card').length > ${String(before)}`,
  15000,
);
r.ok(
  'a session started in one tab appears on another start screen, unrefreshed',
  noticed,
  `${String(before)} -> ${String(await runningIn(watcher.client))}`,
);

/** And a folder made anywhere reaches the folder list. */
{
  const dir = `tabterm-live-${String(Date.now()).slice(-6)}`;
  const listed = () =>
    evaluate(
      watcher.client,
      `JSON.stringify([...document.querySelectorAll('.launcher-completion, .launcher-chip')].map(b => b.textContent))`,
    );
  await type(worker.client, `mkdir -p ~/${dir} && cd ~/${dir}`);
  const appeared = await waitFor(
    watcher.client,
    `document.body.textContent.includes(${JSON.stringify(dir)})`,
    15000,
  );
  r.ok(
    'and a folder opened elsewhere reaches the other start screen too',
    appeared,
    String(await listed()).slice(0, 120),
  );
  await type(worker.client, `cd ~ && rmdir ~/${dir}`);
  await sleep(800);
}

/**
 * And a tab showing a terminal does no work for any of it.
 *
 * The point of saying only "this changed" is that pages which cannot draw the start screen never
 * build it. This checks the cheap half: such a tab keeps its terminal and never opens a launcher.
 */
{
  const busy = await openTerminal();
  await waitFor(busy.client, "document.querySelector('.launcher-input')");
  await type(busy.client, 'echo BUSY-TAB');
  await sleep(2000);
  await evaluate(busy.client, `document.querySelector('.launcher')?.setAttribute('hidden','')`);
  await type(worker.client, 'echo ANOTHER-CHANGE');
  await sleep(2500);
  const stillHidden = await evaluate(
    busy.client,
    `document.querySelector('.launcher')?.hidden !== false`,
  );
  r.ok('a tab showing a terminal ignores the nudge', String(stillHidden) === 'true');
}

await finish();
r.done();
