// The Stats page survives a refresh, because the numbers belong to the session.
//
// Every figure used to be counted in the page showing it. Refreshing the tab reset all of them, so
// a terminal open all day reported four seconds, no commands and nothing answered. The numbers were
// not wrong about the page. They were about the wrong thing: a tab is a view of a session, and the
// session is what did the work.
import { openTerminal, evaluate, sleep, type, finish, waitFor } from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

// Three commands, one of which fails, so the counts have something to be wrong about.
/*
 * Waited for each command's output rather than slept through.
 *
 * Under a full run a shell takes longer than a fixed wait allows, and the next command was typed
 * before the previous one had finished. The counts then disagreed with the commands that had
 * actually run, which reads as the counting being broken.
 */
await type(client, 'echo stats-one\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('stats-one')`, 20000);
await type(client, 'echo stats-two\r');
await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('stats-two')`, 20000);
// A command that fails, not one that ends the shell: `exit` would take the session with it and
// the check after the refresh would be about a different session entirely.
/*
 * One command that fails and says so on the screen, so the wait and the failure are the same
 * event. `(exit 3); echo ...` does not work: the shell reports the exit code of the last command
 * on the line, which is the echo, so the line counted as a success.
 */
await type(client, 'ls /no-such-directory-stats-check\r');
await waitFor(
  client,
  `(window.__tabterm.readScreen() ?? '').includes('no-such-directory-stats-check')`,
  20000,
);
await sleep(700);

/** What the daemon says about the session this tab is showing. */
const ask = async () => {
  await evaluate(client, 'window.__tabterm.statsForTest()');
  const got = await waitFor(client, 'window.__tabterm.lastStatsForTest() !== null', 15000);
  if (!got) return null;
  return JSON.parse(
    String(await evaluate(client, 'JSON.stringify(window.__tabterm.lastStatsForTest())')),
  );
};

const before = await ask();
r.ok(
  'the daemon answers with this session',
  before?.session !== undefined,
  JSON.stringify(before?.session ?? null),
);
r.ok(
  'and has counted the commands that were run',
  (before?.session?.commandsRun ?? 0) >= 3,
  String(before?.session?.commandsRun),
);
r.ok(
  'including the one that failed',
  (before?.session?.commandsFailed ?? 0) >= 1,
  String(before?.session?.commandsFailed),
);
/*
 * The age is the session's, not the page's. A page that has been up for two seconds used to
 * report two seconds for a terminal that had been open all day, which is the report this fixes.
 */
r.ok(
  'and says when the session started rather than when the page loaded',
  typeof before?.session?.startedAt === 'number' && before.session.startedAt > 0,
  String(before?.session?.startedAt),
);

// The refresh, which is what reset everything.
await client.send('Page.reload');
await waitFor(client, 'window.__tabterm?.paneIds().length > 0', 25000);
await sleep(1200);

const after = await ask();
r.ok(
  'the counts survive a refresh',
  (after?.session?.commandsRun ?? 0) >= (before?.session?.commandsRun ?? 0),
  `${String(before?.session?.commandsRun)} -> ${String(after?.session?.commandsRun)}`,
);
r.ok(
  'and so does the moment the session started',
  after?.session?.startedAt === before?.session?.startedAt,
  `${String(before?.session?.startedAt)} -> ${String(after?.session?.startedAt)}`,
);

// The parts that are about the machine rather than this terminal.
r.ok(
  'today is reported',
  typeof after?.today?.commandsRun === 'number',
  JSON.stringify(after?.today),
);
r.ok('and the week', typeof after?.week?.commandsRun === 'number', JSON.stringify(after?.week));
r.ok(
  'and what gets run most, from the history the daemon already keeps',
  Array.isArray(after?.topCommands),
  String(after?.topCommands?.length),
);

await finish();
r.done();
