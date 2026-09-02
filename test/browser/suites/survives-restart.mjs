// The promise this product is built on: a terminal outlives the thing that changes.
//
// Restarting the daemon is what an update does, and it used to kill every session and every
// screen of output. This is the check that would have caught that, so it runs against the real
// daemon and restarts it for real. See docs/adr/0017.
import { execFileSync } from 'node:child_process';
import {
  openTerminal,
  evaluate,
  readScreen,
  sleep,
  type,
  finish,
  waitUntil,
  ready,
} from '../helpers.mjs';
import { reporter } from '../cdp.mjs';

const r = reporter();
const { client } = await openTerminal();
await sleep(1200);

const TAG = String(Date.now()).slice(-6);
await type(client, `echo before-restart-${TAG}`);
await sleep(900);
// A background process is the real test: it has no terminal of its own to keep it alive.
await type(client, 'sleep 400 &');
await sleep(900);

const workspace = await evaluate(client, `new URL(location.href).searchParams.get('workspace')`);
const before = String(await readScreen(client));
r.ok('the marker is on screen before anything happens', before.includes(`before-restart-${TAG}`));

const alive = () => {
  try {
    execFileSync('pgrep', ['-f', 'sleep 400'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
r.ok('and its background job is running', alive());

// Exactly what installing an update does.
try {
  execFileSync(
    'launchctl',
    ['kickstart', '-k', `gui/${String(process.getuid())}/com.tabterm.daemon`],
    {
      stdio: 'pipe',
    },
  );
} catch {
  r.ok('could restart the daemon', false, 'launchctl kickstart failed');
}
// Wait for the daemon to be back rather than for six seconds.
await waitUntil(() => alive());
r.ok('the process survived the daemon restarting', alive());

// The tab has to find its way back on its own.
await evaluate(client, `location.reload()`);
// The tab is usable when it has drawn something, which is what `ready` waits for.
await ready(client);

const body = String(await evaluate(client, `document.body.innerText`));
r.ok('the tab is not told its session expired', !body.includes('expired'), body.slice(0, 80));

const after = String(await readScreen(client));
r.ok(
  'and the output from before the restart is still on screen',
  after.includes(`before-restart-${TAG}`),
  after.split('\n').filter(Boolean).slice(-2).join(' | '),
);

await type(client, `echo after-restart-${TAG}`);
await sleep(1500);
const final = String(await readScreen(client));
r.ok(
  'the adopted session still runs commands',
  final.includes(`after-restart-${TAG}`),
  final.split('\n').filter(Boolean).slice(-1)[0] ?? '',
);

// Leave nothing running.
await type(client, 'kill %1 2>/dev/null');
await sleep(500);
void workspace;

await finish();
r.done();
