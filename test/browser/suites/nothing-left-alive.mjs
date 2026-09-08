// A tab with nothing running left in it says so, rather than showing a dead terminal.
//
// A pane whose session ends is removed by the daemon, which sends a new layout. The last one is
// different: its workspace is dropped with it, so no layout is left to send and nothing arrives to
// change the page. The tab sat there with the final screen frozen in it, no message, no way
// forward, and typing went nowhere.
//
// Three ways to reach that, and all three used to look identical to a hung terminal.
import {
  openTerminal,
  evaluate,
  sleep,
  finish,
  waitFor,
  type,
  ownHostPid,
  waitUntil,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const TAG = String(Date.now()).slice(-5);

/** What the page is showing, once it has had a moment to react. */
const shown = (client) =>
  evaluate(
    client,
    `JSON.stringify({
       recovery: document.getElementById('recovery')?.hidden === false,
       reason: document.getElementById('recovery-reason')?.textContent ?? '',
       buttons: [...document.querySelectorAll('#recovery-actions button')].map((b) => b.textContent),
     })`,
  ).then((raw) => JSON.parse(String(raw)));

// --- the shell exits on its own -------------------------------------------
{
  const { client } = await openTerminal();
  await waitFor(client, "document.querySelector('.pane')");
  await type(client, `echo alive-${TAG}`);
  await waitFor(client, `(window.__tabterm.readScreen() ?? '').includes('alive-${TAG}')`, 15000);

  await type(client, 'exit');
  const said = await waitFor(
    client,
    `document.getElementById('recovery')?.hidden === false`,
    15000,
  );
  /**
   * Waited for the offers, not just for the page.
   *
   * What the recovery page can offer depends on what the daemon remembers about the session, and
   * asking for that is a round trip made after the page appears. Reading the buttons the instant
   * it is shown reads them before the answer arrives.
   */
  await waitFor(client, `document.querySelectorAll('#recovery-actions button').length > 2`, 15000);
  const state = await shown(client);
  r.ok('a shell that exits leaves a tab that says so', said, JSON.stringify(state));
  r.ok(
    'and names what happened rather than saying it expired',
    state.reason.includes('ended'),
    state.reason,
  );
  /**
   * And offers a way on, in the folder it was in.
   *
   * The recovery page keeps what it remembers of the session: the directory, the last command,
   * and the final screen. Nothing is thrown away by showing it.
   */
  r.ok(
    'and offers to start another shell where that one was',
    state.buttons.some((b) => /shell here/i.test(b)),
    JSON.stringify(state.buttons),
  );
}

// --- the PTY host dies underneath the tab ---------------------------------
{
  const { client } = await openTerminal();
  await waitFor(client, "document.querySelector('.pane')");
  await type(client, `echo host-death-${TAG}`);
  await waitFor(
    client,
    `(window.__tabterm.readScreen() ?? '').includes('host-death-${TAG}')`,
    15000,
  );

  const hostPid = ownHostPid();
  if (hostPid === null) {
    r.skip('a tab whose host dies says so', 'no host of our own to end');
  } else {
    /**
     * The host, killed outright.
     *
     * Nothing survives this: it holds the only handles to every terminal it owns. What the tab
     * must not do is pretend otherwise, which is what showing the last screen forever amounts to.
     */
    process.kill(hostPid, 'SIGKILL');
    await waitUntil(() => ownHostPid() !== null && ownHostPid() !== hostPid, 45000);
    const said = await waitFor(
      client,
      `document.getElementById('recovery')?.hidden === false`,
      30000,
    );
    const state = await shown(client);
    r.ok('a tab whose host dies says so rather than freezing', said, JSON.stringify(state));
    r.ok(
      'and offers a way on from there too',
      state.buttons.length > 0,
      JSON.stringify(state.buttons),
    );
  }
}

// --- and a tab with another pane still alive is left alone ----------------
{
  const { client } = await openTerminal();
  await waitFor(client, "document.querySelector('.pane')");
  await type(client, `echo two-panes-${TAG}`);
  await waitFor(client, `document.querySelector('.launcher')?.hidden === true`, 10000);
  await sleep(600);
  await evaluate(client, `window.__tabterm.split('horizontal')`);
  const split = await waitFor(client, `document.querySelectorAll('.pane').length === 2`, 15000);
  if (!split) {
    r.skip('one pane ending leaves the tab alone', 'the split did not happen');
  } else {
    await sleep(1200);
    // End the focused one. The other is still running, so the tab carries on.
    await type(client, 'exit');
    const gone = await waitFor(client, `document.querySelectorAll('.pane').length === 1`, 15000);
    r.ok('one pane of two ending removes that pane', gone);
    const state = await shown(client);
    r.ok(
      'and the tab carries on, because something is still running in it',
      state.recovery === false,
      JSON.stringify(state),
    );
  }
}

await finish();
r.done();
