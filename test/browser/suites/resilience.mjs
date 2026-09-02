// What happens when things die.
//
// The product's whole claim is that a terminal outlives the things around it, so the failures
// worth testing are the ones nobody schedules: a browser killed outright, a daemon killed
// mid-command, and the process holding the PTYs killed, which no session can survive.
import { execFileSync } from 'node:child_process';
import {
  openTerminal,
  readScreen,
  sleep,
  type,
  finish,
  waitUntil,
  waitFor,
  evaluate,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const TAG = String(Date.now()).slice(-6);

const alive = (pattern) => {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

// --- a daemon killed while a command is still producing output ------------
const { client } = await openTerminal();
await sleep(2000);
await type(client, `for i in 1 2 3 4 5 6 7 8; do echo tick-${TAG}-$i; sleep 1; done`);
await sleep(2500);

try {
  execFileSync('kill', [
    '-9',
    execFileSync('pgrep', ['-f', 'libexec/tabterm/daemon.mjs'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')[0],
  ]);
} catch {
  r.ok('could kill the daemon', false, 'pgrep or kill failed');
}
// Polled, not slept through. This was fourteen seconds of fixed waiting chosen to cover the
// worst case, and the worst case is not the common one.
await waitUntil(() => alive('pty-host.mjs') && alive());
r.ok('the PTY host outlives the daemon being killed', alive('pty-host.mjs'));

const after = String(await readScreen(client));
r.ok(
  'a command keeps running through it and finishes',
  after.includes(`tick-${TAG}-8`),
  after.split('\n').filter(Boolean).slice(-1)[0] ?? '',
);

await type(client, `echo usable-${TAG}`);
await sleep(2500);
r.ok(
  'and the session is usable again without a reload',
  String(await readScreen(client)).includes(`usable-${TAG}`),
);

// --- the host itself, which no session can survive -------------------------
try {
  execFileSync('pkill', ['-9', '-f', 'pty-host.mjs']);
} catch {
  /* nothing running is a fine starting point */
}
await waitUntil(() => alive('pty-host.mjs'));
r.ok('a new host is started automatically after the old one dies', alive('pty-host.mjs'));

const fresh = await openTerminal();
/**
 * Wait for the prompt before typing, with a budget for a cold start.
 *
 * `openTerminal` waits too, but its budget assumes a daemon that is already up. Here the daemon
 * has just been killed and restarted by launchd and the PTY host has been respawned from
 * nothing, so the first shell takes noticeably longer. Typing into a tab that has no prompt yet
 * sends the keystrokes nowhere, and the check that follows then fails for a reason that has
 * nothing to do with recovery.
 */
await waitFor(fresh.client, "(window.__tabterm.readScreen() ?? '').trim() !== ''", 40000);
await type(fresh.client, `echo recovered-${TAG}`);
// Waited for, not slept through. A shell that has just been started by a freshly respawned host
// takes longer than one on a quiet machine, and a fixed wait here is the difference between a
// green run and a failure that reads as the recovery not working.
const recovered = await waitFor(
  fresh.client,
  `(window.__tabterm.readScreen() ?? '').includes(${JSON.stringify(`recovered-${TAG}`)})`,
  // Generous on purpose. A daemon that has just been killed comes back cold, and this is the
  // one check in the run that is legitimately waiting on a process to start from nothing.
  45000,
);
r.ok(
  'and TabTerm still works, rather than needing a daemon restart',
  recovered,
  // Enough to tell "the tab never got a session" apart from "the shell never printed", which
  // an empty screen alone cannot.
  JSON.stringify({
    screen: String(await readScreen(fresh.client)).slice(0, 60),
    transport: String(await evaluate(fresh.client, 'window.__tabterm?.transport?.() ?? "no hook"')),
  }),
);

r.ok('the daemon is running again, restarted by launchd', alive('libexec/tabterm/daemon.mjs'));

await finish();
r.done();
