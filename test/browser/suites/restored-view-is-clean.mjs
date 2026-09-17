// A restored tab comes back as a terminal, not as the ghost of the program that was in it.
//
// Reported after a machine crash: several tabs were restored, every one of them showed a second
// typing indicator that was not the agent's, and the sessions did not work. Anything typed into a
// resumed agent came straight back as "Interrupted by user".
//
// One cause. A saved screen carries the modes its program had set, and several of those govern
// input rather than drawing: mouse reporting, focus reporting, application cursor keys, bracketed
// paste, and whether the cursor is drawn. Replaying that screen into a new shell armed all of them
// against a process that never asked for any of them, so a click or a focus change or an arrow key
// sent escape sequences nobody typed. A stray escape is an agent's interrupt key.
import {
  openTerminal,
  evaluate,
  sleep,
  type,
  finish,
  waitFor,
  waitUntil,
  realClick,
  ownDaemonPid,
} from '../helpers.mjs';
import { reporter, listTargets, connect } from '../cdp.mjs';

const r = reporter();

/** Exactly what an agent's interface turns on, written by hand so the test owns the setup. */
const AGENT_MODES = `printf '\\033[?1h\\033[?1002h\\033[?1006h\\033[?1004h\\033[?2004h\\033[?25l'`;

const inputState = async (client) =>
  JSON.parse(String(await evaluate(client, 'JSON.stringify(window.__tabterm.inputState())')));

const work = await openTerminal();
await waitFor(work.client, "document.querySelector('.launcher-input')");
/*
 * In a directory of its own, because a shell sitting in the home directory with nothing run in it
 * is deliberately never offered back: a layout of untouched shells has nothing in it to reopen.
 */
await type(work.client, 'mkdir -p /tmp/tt-restored && cd /tmp/tt-restored\r');
await sleep(1200);
await type(work.client, `echo RESTORE-ME; ${AGENT_MODES}\r`);
await waitFor(work.client, `(window.__tabterm.readScreen() ?? '').includes('RESTORE-ME')`, 20000);
await sleep(800);

/*
 * The live pane really is in that state, which is what makes the rest of this a test of anything.
 * A program that is running is entitled to every one of these.
 */
const live = await inputState(work.client);
r.ok(
  'a pane running such a program has those modes on',
  live?.modes.mouseTrackingMode === 'drag' && live.cursorHidden === true,
  JSON.stringify(live),
);

/*
 * And they survive a reload, because the program is still running and still expects them. This is
 * the half the serializer nearly gets right: it restores the tracking and, until this was fixed,
 * neither the hidden cursor nor the format the reports are in.
 */
await evaluate(work.client, 'location.reload()');
await sleep(1000);
await waitFor(work.client, 'window.__tabterm?.attached?.() === true', 25000);
await sleep(1200);
const replayed = await inputState(work.client);
r.ok(
  'and a reload brings the program its terminal back, hidden cursor and all',
  replayed?.cursorHidden === true,
  JSON.stringify(replayed),
);
r.ok(
  'including the mouse tracking it asked for',
  replayed?.modes.mouseTrackingMode === 'drag',
  JSON.stringify(replayed),
);

/*
 * Now the case that was broken. A layout change writes the screen down, the sessions are ended, and
 * what is left is a saved screen with no process behind it, which is what a crash leaves.
 */
await evaluate(work.client, "window.__tabterm.split('horizontal')");
await waitFor(work.client, 'window.__tabterm.paneIds().length === 2', 20000);
await sleep(1200);
/*
 * The new pane is the one that goes, named rather than assumed.
 *
 * Closing whichever pane happened to be focused closed the one with the work in it, and a pane
 * that leaves a layout stops being restorable, which is correct and meant the rest of this suite
 * was restoring an empty shell and calling it a failure.
 */
const bothPanes = JSON.parse(
  String(await evaluate(work.client, 'JSON.stringify(window.__tabterm.paneIds())')),
);
await evaluate(work.client, `window.__tabterm.focus(${JSON.stringify(bothPanes[1])})`);
await sleep(500);
await evaluate(work.client, 'window.__tabterm.closePane()');
await sleep(1500);
await waitFor(work.client, 'window.__tabterm.paneIds().length === 1', 20000);
/*
 * And now the crash, as nearly as a test can have one.
 *
 * The shell is killed rather than closed, because a tab somebody closes on purpose is recorded as
 * closed and deliberately never offered back. Then the daemon is killed, because a workspace is
 * only offered for reopening once it is not live any more, and while this daemon is running it
 * holds the workspace whether or not anything is left in it. Both together are what a machine
 * going down leaves behind, which is the state that was reported.
 *
 * This is why the suite runs in the phase that is allowed to kill the daemon.
 */
await type(work.client, 'kill -9 $$\r');
await sleep(2500);
const daemonPid = ownDaemonPid();
if (daemonPid === null) {
  r.ok('there is a daemon of our own to restart', false, 'run via run.mjs');
  await finish();
  r.done();
}
process.kill(daemonPid, 'SIGKILL');
await waitUntil(
  async () =>
    String(await evaluate(work.client, 'JSON.parse(window.__tabterm.transport()).status')) ===
    'ready',
  30000,
);
await sleep(1500);

const back = await openTerminal();
await waitFor(back.client, "document.querySelector('.launcher-input')");
/** The rows of the restore section itself, rather than any row that happens to say "pane". */
const restoreRows = async () =>
  JSON.parse(
    String(
      await evaluate(
        back.client,
        `(() => {
           const head = [...document.querySelectorAll('.launcher-heading')]
             .find((h) => (h.textContent ?? '').includes('Reopen from before the restart'));
           const box = head?.closest('.launcher-section') ?? head?.parentElement;
           return JSON.stringify(
             [...(box?.querySelectorAll('.launcher-row') ?? [])].map((b) => b.textContent ?? ''),
           );
         })()`,
      ),
    ),
  );

const offered = await waitUntil(async () => (await restoreRows()).length > 0, 25000);
const whatIsThere = String(
  await evaluate(
    back.client,
    `JSON.stringify({
       hasHeading: (document.body.textContent ?? '').includes('Reopen from before the restart'),
       headings: [...document.querySelectorAll('.launcher-heading')].map((h) => h.textContent),
     })`,
  ),
);
r.ok('the tab that lost its processes is offered back', offered, whatIsThere);

// Open the offer, then take it. Two presses, which is what a person does.
const label = (await restoreRows())[0] ?? '';
if (label === '') {
  r.ok('there is an offer to take', false, 'nothing to click');
  await finish();
  r.done();
}
const known = new Set((await listTargets()).map((t) => t.id));
await realClick(back.client, '.launcher-row', label);
await sleep(600);
const took = await realClick(back.client, '.launcher-chip', 'Reopen the layout');
const chips = String(
  await evaluate(
    back.client,
    `JSON.stringify([...document.querySelectorAll('.launcher-row, .launcher-chip')].map((e) => e.className + ':' + (e.textContent ?? '').slice(0, 40)))`,
  ),
);
r.ok('and the layout can be reopened', took, chips);
await sleep(3500);

/*
 * The reopened layout arrives in a tab of its own.
 *
 * Which is right: this tab is a start screen somebody is using, and taking it over would be a
 * second thing happening that nobody asked for. So the checks below are about that new tab.
 */
const fresh = (await listTargets()).find(
  (t) => !known.has(t.id) && (t.url ?? '').includes('terminal.html'),
);
r.ok('the reopened layout gets a tab', fresh !== undefined);
if (fresh === undefined) {
  await finish();
  r.done();
}
const restored = connect(fresh.webSocketDebuggerUrl);
await restored.ready;
await waitFor(restored, 'window.__tabterm?.attached?.() === true', 25000);
await sleep(2000);

/*
 * The screen is there. That is the whole reason a restore writes it, and a fix that cleaned the
 * terminal by throwing the work away would be worse than the bug.
 */
const screen = String(await evaluate(restored, `window.__tabterm.readScreen() ?? ''`));
r.ok(
  'the work that was on the screen is on the screen',
  screen.includes('RESTORE-ME'),
  JSON.stringify({ label, screen: screen.replace(/\s+/g, ' ').slice(0, 300) }),
);

/*
 * And the terminal is a new shell's, not the dead program's. Each of these is a way for the
 * terminal to send bytes the person did not type.
 */
const after = await inputState(restored);
r.ok(
  'the mouse is not being reported to a program that never asked',
  after?.modes.mouseTrackingMode === 'none',
  JSON.stringify(after),
);
r.ok(
  'focus changes are not being reported either',
  after?.modes.sendFocusMode === false,
  JSON.stringify(after),
);
r.ok(
  'an arrow key sends what a shell expects',
  after?.modes.applicationCursorKeysMode === false,
  JSON.stringify(after),
);
r.ok(
  'and there is a cursor the person can see',
  after?.cursorHidden === false,
  JSON.stringify(after),
);

/*
 * And the restored pane is usable, which is the thing that was actually reported. Typed at the new
 * shell, so if anything above were still armed the line would have something in it that was never
 * typed.
 */
await type(restored, 'echo STILL-WORKS\r');
const works = await waitUntil(
  async () =>
    String(await evaluate(restored, `window.__tabterm.readScreen() ?? ''`)).includes('STILL-WORKS'),
  20000,
);
r.ok('and the restored pane runs what is typed into it', works);

await finish();
r.done();
