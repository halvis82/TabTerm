// The offer to open a folder appears over a pane with nothing in it, and over no other pane, at no
// point during any of the ways a tab comes back.
//
// His conditions, named: more than one session pane in a tab, and then the extension reloaded, the
// page refreshed, or a session brought back from the background. In each of those the page is
// rebuilt and has to decide what each pane is before it has seen any of them.
//
// The state this exists for is a pane running an agent, and it is the state where every other
// answer is no. The command in that pane is the agent itself and it runs for hours, so no command
// finishes and no command starts in a new daemon's lifetime. The agent draws on the alternate
// buffer, so what is restored serializes to almost nothing. The only evidence left is that
// somebody has been typing into it.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  ownDaemonPid,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await waitFor(client, "document.querySelector('.launcher-input')");

// One pane that has run something, which is the ordinary case and must keep working.
await type(client, 'echo PANE-RAN-SOMETHING\r');
await waitFor(
  client,
  `(window.__tabterm.readScreen() ?? '').includes('PANE-RAN-SOMETHING')`,
  20000,
);

// And one that has only ever been typed into, which is the shape of a pane running an agent.
await evaluate(client, "window.__tabterm.split('horizontal')");
await waitFor(client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1500);
const [ran, typedOnly] = JSON.parse(
  String(await evaluate(client, 'JSON.stringify(window.__tabterm.paneIds())')),
);
await evaluate(client, `window.__tabterm.focus(${JSON.stringify(typedOnly)})`);
await sleep(500);
await type(client, 'a prompt nobody has submitted', { submit: false });
await sleep(1200);

const linesIn = async (id) =>
  Number(
    await evaluate(
      client,
      `(window.__tabterm.readScreen(${JSON.stringify(id)}) ?? '').split('\\n').filter((l) => l.trim()).length`,
    ),
  );

r.ok('both panes have something in them', (await linesIn(ran)) > 1);

/**
 * The daemon restarted, which is what makes this the state being checked rather than an easier one.
 *
 * While this daemon is the one that started the sessions it remembers that a command was run in
 * them, and that answer alone keeps the offer away. His case is a session **adopted** from a
 * previous daemon, which is what an update or a reinstall leaves behind, and adoption has to work
 * out for itself whether anybody has been working in each one. That is where a pane running an
 * agent has no good answer: the command is the agent and it has not finished, nothing started in
 * this daemon's lifetime, and a full-screen program serializes to almost nothing.
 *
 * This suite therefore runs in the phase that is allowed to kill the daemon, beside the others
 * that do, because every suite sharing it would lose its sessions.
 */
const daemonPid = ownDaemonPid();
if (daemonPid === null) {
  r.ok('there is a daemon of our own to restart', false, 'run via run.mjs');
  await finish();
  r.done();
}
process.kill(daemonPid, 'SIGKILL');
await waitUntil(
  async () =>
    String(await evaluate(client, 'JSON.parse(window.__tabterm.transport()).status')) === 'ready',
  30000,
);
r.ok('the daemon came back and the tab reattached', true);

/** Offers drawn over one particular pane, rather than anywhere in the tab. */
const offerOver = async (id) =>
  Number(
    await evaluate(
      client,
      `document.querySelectorAll('.pane[data-pane-id="${id}"] .pane-chooser').length`,
    ),
  );

/**
 * Watched continuously through whatever is done, not sampled afterwards.
 *
 * "It was there for like 1.5 seconds and then it went away" is invisible to a check that looks
 * once at the end, and the end state was never what was wrong.
 */
async function watch(what, ms) {
  let sawOver = { ran: 0, typedOnly: 0 };
  let samples = 0;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await offerOver(ran)) > 0) sawOver.ran += 1;
      if ((await offerOver(typedOnly)) > 0) sawOver.typedOnly += 1;
    } catch {
      // Between documents, which has nothing on screen to be wrong.
    }
    samples += 1;
    await sleep(50);
  }
  r.ok(
    `${what}: no offer over the pane that ran something`,
    sawOver.ran === 0,
    `${String(sawOver.ran)} of ${String(samples)}`,
  );
  r.ok(
    `${what}: no offer over the pane somebody was typing in`,
    sawOver.typedOnly === 0,
    `${String(sawOver.typedOnly)} of ${String(samples)}`,
  );
}

// 1. The page refreshed, which is the one he sees most.
await client.send('Page.reload');
await watch('after a refresh', 14000);
await waitFor(client, 'window.__tabterm?.paneIds().length === 2', 25000);

// 2. The connection lost and regained, which is what an extension reload leaves behind: the page
// survives, everything it knew about the daemon does not, and it attaches again from nothing.
await evaluate(client, 'window.__tabterm.loseConnection()');
await watch('after losing and regaining the connection', 12000);

r.ok(
  'and both panes are still there at the end',
  Number(await evaluate(client, 'window.__tabterm.paneIds().length')) === 2,
);

await finish();
r.done();
