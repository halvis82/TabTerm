// What happens when things die.
//
// The product's whole claim is that a terminal outlives the things around it, so the failures
// worth testing are the ones nobody schedules: a browser killed outright, a daemon killed
// mid-command, and the process holding the PTYs killed, which no session can survive.
import { execFileSync } from 'node:child_process';
import { openTerminal, evaluate, readScreen, sleep, type, finish } from '../helpers.mjs';
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
await sleep(14000);

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
await sleep(7000);

r.ok('a new host is started automatically after the old one dies', alive('pty-host.mjs'));

const fresh = await openTerminal();
await sleep(3500);
await type(fresh.client, `echo recovered-${TAG}`);
await sleep(2500);
r.ok(
  'and TabTerm still works, rather than needing a daemon restart',
  String(await readScreen(fresh.client)).includes(`recovered-${TAG}`),
);

r.ok('the daemon is running again, restarted by launchd', alive('libexec/tabterm/daemon.mjs'));

await finish();
r.done();
