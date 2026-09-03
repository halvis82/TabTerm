// The new tab has to say what already exists, including sessions no tab is showing.
//
// A path is not enough to recognize a terminal, so this checks the preview carries the actual
// output, and that "open in a tab" is told apart from "no tab".
import { openTerminal, evaluate, sleep, type, finish } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const TAG = String(Date.now()).slice(-6);

const first = await openTerminal();
await sleep(1500);
await type(first.client, `echo session-marker-${TAG}`);
await sleep(1200);

// A second tab, whose start screen lists the first.
const viewer = await openTerminal();
await sleep(2500);

const cards = Number(
  await evaluate(viewer.client, `document.querySelectorAll('.session-card').length`),
);
r.ok('the start screen lists sessions that already exist', cards > 0, `${String(cards)} cards`);

const previews = String(
  await evaluate(
    viewer.client,
    `[...document.querySelectorAll('.session-screen')].map(p => p.textContent).join('\\n')`,
  ),
);
r.ok(
  'and shows what each one actually printed, not only its path',
  previews.includes(`session-marker-${TAG}`),
  previews.split('\n').filter(Boolean).slice(-1)[0] ?? '',
);

const badges = JSON.parse(
  await evaluate(
    viewer.client,
    `JSON.stringify([...document.querySelectorAll('.session-badge')].map(b => b.textContent))`,
  ),
);
r.ok(
  'a session with a tab is distinguished from one without',
  badges.includes('open in a tab'),
  badges.slice(0, 3).join(', '),
);

r.ok(
  'every card can be reached by keyboard',
  (await evaluate(viewer.client, `document.querySelector('.session-card')?.tabIndex`)) === 0,
);

// Ending one from the list.
const before = Number(
  await evaluate(viewer.client, `document.querySelectorAll('.session-card').length`),
);
await evaluate(viewer.client, `document.querySelector('.session-card .session-close')?.click()`);
await sleep(2000);
await evaluate(viewer.client, `location.reload()`);
await sleep(5000);
const after = Number(
  await evaluate(viewer.client, `document.querySelectorAll('.session-card').length`),
);
r.ok(
  'a session can be ended from the list',
  after < before,
  `${String(before)} -> ${String(after)}`,
);

/**
 * A workspace whose session ended still says what happened in it.
 *
 * Killing the session here stands in for the timeout, which takes minutes. What is being checked
 * is the same path: a workspace whose pane is gone must report that plainly rather than attaching
 * to a session that no longer exists, which used to render an entirely blank page.
 */
const gone = await openTerminal();
await sleep(1500);
await type(gone.client, `echo gone-marker-${TAG}`);
await sleep(1200);
const goneWorkspace = await evaluate(
  gone.client,
  `new URL(location.href).searchParams.get('workspace')`,
);
await evaluate(gone.client, `window.__tabterm.endSessions()`);
await sleep(2500);

const revisit = await openTerminal(`?workspace=${String(goneWorkspace)}`);
await sleep(5000);
const revisited = String(await evaluate(revisit.client, `document.body.innerText`));
r.ok(
  'a workspace whose session ended says so, rather than rendering nothing',
  revisited.includes('expired'),
  revisited.slice(0, 60).replace(/\n+/g, ' | '),
);

/**
 * The tab Chrome brings back with Command+Shift+T.
 *
 * Chrome cannot be asked to forget one entry in its recently-closed stack, so restoring the URL
 * of a session that is gone is ordinary rather than exceptional. The page has to be worth
 * landing on: it must say where the session was and offer a shell in that same folder, one
 * press away. Nothing starts by itself, which is the rule in docs/04-session-lifecycle.md.
 */
const offers = String(
  await evaluate(revisit.client, `document.querySelector('#recovery-actions')?.innerText ?? ''`),
);
const detail = String(
  await evaluate(revisit.client, `document.querySelector('#recovery-detail')?.innerText ?? ''`),
);
r.ok(
  'the expired tab says which folder the session was in',
  detail.includes('Last directory'),
  detail.slice(0, 120).replace(/\n+/g, ' | '),
);
r.ok(
  'and offers a shell in that same folder',
  offers.toLowerCase().includes('here'),
  offers.replace(/\n+/g, ' | '),
);
// One press away, and nothing has started by itself. Both halves matter: the offer is focused so
// Return takes it, and no pane exists until somebody does.
r.ok(
  'that offer is what Return will take',
  String(await evaluate(revisit.client, `document.activeElement?.textContent ?? ''`)).includes(
    'here',
  ),
  String(await evaluate(revisit.client, `document.activeElement?.textContent ?? ''`)),
);
r.ok(
  'and nothing has started on its own',
  Number(await evaluate(revisit.client, `document.querySelectorAll('.pane').length`)) === 0,
);

await finish();
r.done();
