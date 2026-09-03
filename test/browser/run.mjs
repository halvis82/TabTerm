/**
 * Run every browser suite against one daemon and one headless browser.
 *
 * Replaces a shell loop that ran 28 suites strictly one after another, each opening its own tab
 * and waiting out fixed sleeps. Most of that time was spent waiting on nothing: the suites are
 * independent, and the machine was running one at a time.
 *
 * Two things make it quick.
 *
 * **Suites that can share the browser run together.** Each opens its own tab and its own
 * sessions, so several can be in flight at once. The exceptions are listed below and are run one
 * at a time, first, because they touch state everything else can see.
 *
 * **Nothing waits on a clock it does not have to.** `openTerminal` polls for a live prompt
 * instead of sleeping for four seconds, which is most of the fixed waiting in the whole run.
 *
 * Setup that touches shared state lives here rather than in a suite. A suite that restarted the
 * daemon for its own purposes once took down every suite after it, and the failures looked like
 * nine unrelated product bugs.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SUITES = join(HERE, 'suites');

/**
 * Suites that cannot share the browser with anything else.
 *
 * Each one either takes the daemon away, resets state everything reads, or counts things that
 * belong to the whole browser. Running one of these beside another suite does not produce a
 * flake, it produces a confident wrong answer, which is worse.
 */
/**
 * Three phases, and the order of them is the whole design.
 *
 * **First**, alone: suites that read or wipe state everything else can see, or that count things
 * belonging to the whole browser. Running one of these beside another suite does not produce a
 * flake, it produces a confident wrong answer.
 */
const FIRST = [
  // Wipes stored state that every other suite reads.
  'reset',
  // Counts tabs and sessions across the whole browser, so another suite's tab is a wrong answer.
  'pane-chooser',
  'resume-and-tabs',
  'sessions',
  // Measures how many messages arrive in a window. Other suites' traffic is noise in that.
  'no-busy-loop',
];

/**
 * **Last**, alone, after everything else has finished: the suites that take the daemon away.
 *
 * They kill the daemon and the PTY host on purpose, and while those are down every other suite
 * in every other browser is stuck waiting on a connection that is not coming back. Run before
 * the pool, one of them turned a five minute run into eighteen: `resilience` itself took 1070
 * seconds and the suites running alongside it took 1075, all of them waiting on the same dead
 * daemon. Nothing may be in flight while these run.
 */
/**
 * `resilience` kills the PTY host, which ends **every terminal on the machine**, including ones
 * a person is working in. It is not part of an ordinary run for that reason: set
 * `TT_DESTRUCTIVE=1` when you mean it, on a machine where losing every shell is acceptable.
 *
 * `survives-restart` only restarts the daemon, which sessions are designed to outlive, so it
 * stays in every run.
 */
const LAST = ['survives-restart', 'resilience'];

/**
 * Left out of an ordinary run unless asked for.
 *
 * `resilience` kills the PTY host. Against the suites' own daemon that costs nothing, but the
 * cost of getting the wiring wrong once is somebody's work, so it stays opt-in.
 *
 * Excluded from the **whole** run, not merely from the last phase. Taking it out of the phase
 * list alone quietly promoted it into the parallel pool, where it killed a host while four
 * browsers were using it: a worse outcome than leaving it where it was.
 */
const SKIP = process.env['TT_DESTRUCTIVE'] === '1' ? [] : ['resilience'];

const SERIAL = [...FIRST, ...LAST];

const JOBS = Number(process.env['TT_JOBS'] ?? '4');
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('-'));

/**
 * Which suites cover which parts of the tree.
 *
 * For `--changed`, which runs only the suites that could plausibly have broken. A full run is
 * for before a commit; while working on one thing, running twenty-eight suites to check one is
 * most of the wait for none of the information.
 *
 * A path that matches nothing here runs **everything**, deliberately. An out-of-date table that
 * quietly skips the suite that would have caught the bug is worse than no table, so the failure
 * mode is running too much rather than too little. Prefixes, first match wins.
 */
const COVERS = [
  ['extension/src/terminal/highlight', ['highlights']],
  ['extension/src/terminal/color-', ['highlights', 'pane-label']],
  ['extension/src/terminal/markers', ['markers', 'highlights']],
  ['extension/src/terminal/label-form', ['pane-label']],
  ['extension/src/terminal/pane-chooser', ['pane-chooser']],
  ['extension/src/terminal/quote-path', ['opening-and-undo']],
  ['extension/src/terminal/xterm-controller', ['pane-menu', 'menu-aftermath', 'selection-copy']],
  ['extension/src/terminal/path-links', ['link-hover']],
  ['extension/src/terminal/hotstrings', ['hotstrings']],
  ['extension/src/layout/', ['layout', 'workspace', 'resume-and-tabs']],
  ['extension/src/launcher/', ['palette', 'palette-selection', 'command-panel', 'panel-focus']],
  ['daemon/src/agent-', ['resume-and-tabs']],
  ['daemon/src/codex-', ['resume-and-tabs']],
  ['daemon/src/cleanup', ['sessions']],
  ['daemon/src/pty-host/', ['survives-restart', 'resilience']],
  ['daemon/src/pty-manager', ['survives-restart', 'resilience', 'terminal']],
  ['daemon/src/restore-store', ['reattach']],
  ['daemon/src/project-', ['project-trust']],
  ['daemon/src/notify', ['notifications']],
];

function changedSuites() {
  const changed = execFileSync('git', ['status', '--porcelain', '-uall'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  if (changed.length === 0) return [];

  const picked = new Set();
  for (const path of changed) {
    if (path.startsWith('test/browser/suites/')) {
      picked.add(path.replace('test/browser/suites/', '').replace(/\.mjs$/, ''));
      continue;
    }
    // Nothing to do with what runs.
    if (path.startsWith('docs/') || path.startsWith('AGENTS/') || path.endsWith('.test.ts')) {
      continue;
    }
    const hit = COVERS.find(([prefix]) => path.startsWith(prefix));
    if (!hit) return null; // Unmapped: say so by asking for everything.
    for (const suite of hit[1]) picked.add(suite);
  }
  return [...picked];
}

function suiteNames() {
  let wanted = only;
  if (args.includes('--changed')) {
    const picked = changedSuites();
    if (picked === null) {
      console.log('  changed files reach code no suite is mapped to, so running everything');
    } else if (picked.length === 0) {
      console.log('  nothing changed that any suite covers');
      process.exit(0);
    } else {
      wanted = picked;
      console.log(`  changed: running ${picked.join(', ')}`);
    }
  }
  return (
    readdirSync(SUITES)
      .filter((f) => f.endsWith('.mjs'))
      // iCloud sync conflict copies are stale duplicates of a real suite, and running one reports
      // yesterday's results beside today's under a name that looks almost right.
      .filter((f) => !/ \d\.mjs$/.test(f))
      .map((f) => f.replace(/\.mjs$/, ''))
      .filter((n) => wanted.length === 0 || wanted.includes(n))
      // Named explicitly, it runs; left to the default set, it does not.
      .filter((n) => only.includes(n) || !SKIP.includes(n))
      .sort()
  );
}

function runSuite(name, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(SUITES, `${name}.mjs`)], {
      cwd: ROOT,
      env: { ...process.env, TT_CDP_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', () => {
      const lines = out.split('\n');
      resolve({
        name,
        seconds: (Date.now() - started) / 1000,
        pass: lines.filter((l) => l.startsWith('  PASS')).length,
        fail: lines.filter((l) => l.startsWith('  FAIL')).length,
        failures: lines.filter((l) => l.startsWith('  FAIL')),
        last: (lines.filter((l) => l.trim() !== '').pop() ?? '').trim(),
      });
    });
  });
}

/** Killed if it overruns. Tidying up must never cost more than the run it is tidying after. */
function sweep() {
  try {
    execFileSync(process.execPath, [join(HERE, 'sweep.mjs')], {
      cwd: ROOT,
      stdio: 'ignore',
      timeout: 30_000,
    });
  } catch {
    // Sweeping is best effort by definition.
  }
}

const results = [];
function report(r) {
  results.push(r);
  for (const f of r.failures) console.log(f);
  console.log(`  ${r.name.padEnd(18)} ${r.last.padEnd(18)} ${r.seconds.toFixed(1)}s`);
}

/**
 * A bounded pool, one browser per worker.
 *
 * Not one browser shared between them. Suites drive the tab that is in front, so several of them
 * in one browser fight over which that is: keystrokes land in another suite's terminal and the
 * failure reads as a product bug rather than as a harness collision. A browser each costs a
 * couple of seconds at startup and removes the whole class of problem.
 */
async function pool(names, ports) {
  const queue = [...names];
  const workers = ports.map(async (port) => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      report(await runSuite(next, port));
    }
  });
  await Promise.all(workers);
}

/**
 * A daemon of the suites' own, with its own home.
 *
 * `TABTERM_HOME` moves the config, the state, the database, the token and the PTY host socket,
 * so this is a genuinely separate installation rather than the same one on another port. The
 * suites can then do anything at all, including ending every session they can see, without
 * being able to touch a terminal somebody is working in.
 *
 * Returns what the browsers need to find it.
 */
/**
 * A free port, from the operating system.
 *
 * A fixed one was a running battle: an interrupted run leaves its daemon holding it, the next
 * run cannot bind, its supervisor restarts it a dozen times, and every suite fails for reasons
 * that read as product bugs. Binding to port 0 and reading back what was given cannot collide
 * with a previous run, a colleague, or anything else on the machine.
 */
async function freePort() {
  const server = createServer();
  // `listen` is asynchronous, so the address is not there until it says so. Reading it straight
  // after the call returns null, which is how this first went wrong.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startTestDaemon() {
  const home = mkdtempSync(join(tmpdir(), 'tabterm-suite-home-'));
  const port = Number(process.env['TT_DAEMON_PORT'] ?? '') || (await freePort());
  const state = { child: null, pid: 0, stopping: false, restarts: 0 };

  /**
   * Restarted when it dies, which is what launchd does for the real one.
   *
   * `survives-restart` kills it on purpose to prove that terminals outlive a daemon being
   * replaced. Without something putting it back, that check would be testing a machine with no
   * daemon on it. Bounded, so a daemon that cannot start at all says so instead of failing
   * quietly a hundred times.
   */
  const log = openSync(join(home, 'daemon.log'), 'a');
  const spawnOnce = () => {
    const child = spawn(process.execPath, [join(ROOT, 'daemon', 'dist', 'main.js')], {
      cwd: ROOT,
      env: { ...process.env, TABTERM_HOME: home, TABTERM_PORT: String(port) },
      stdio: ['ignore', log, log],
    });
    state.child = child;
    state.pid = child.pid ?? 0;
    child.on('exit', (code, signal) => {
      if (state.stopping) return;
      state.restarts++;
      if (state.restarts > 12) {
        console.log(
          `  the test daemon keeps dying (${String(code ?? signal)}); see ${home}/daemon.log`,
        );
        return;
      }
      spawnOnce();
    });
  };
  spawnOnce();

  const child = {
    get pid() {
      return state.pid;
    },
    kill: (signal) => {
      state.stopping = true;
      state.child?.kill(signal);
    },
  };

  // It writes its token on startup; the browsers need it to authenticate.
  const tokenFile = join(home, '.local', 'state', 'tabterm', 'token');
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (existsSync(tokenFile)) break;
    if (Date.now() > deadline)
      throw new Error(`the test daemon never started; see ${home}/daemon.log`);
    execFileSync('sleep', ['0.2']);
  }
  return { home, port, child, token: readFileSync(tokenFile, 'utf8').trim(), state };
}

function startBrowser(port) {
  execFileSync('bash', [join(HERE, 'launch.sh')], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TT_CDP_PORT: String(port) },
  });
  execFileSync(process.execPath, [join(HERE, 'load-extension.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TT_CDP_PORT: String(port) },
  });
}

const started = Date.now();

if (process.env['TT_SKIP_BUILD'] !== '1') {
  execFileSync('npm', ['run', '--silent', 'build'], { cwd: ROOT, stdio: 'ignore' });
}
const names = suiteNames();
// Kept in the declared order, not alphabetical: which phase a suite is in is load bearing.
const first = FIRST.filter((n) => names.includes(n));
const last = LAST.filter((n) => names.includes(n));
const parallel = names.filter((n) => !SERIAL.includes(n));

const BASE_PORT = Number(process.env['TT_CDP_PORT'] ?? '9223');
const width = Math.max(1, Math.min(JOBS, parallel.length || 1));
const ports = Array.from({ length: width }, (_, i) => BASE_PORT + i);

/**
 * `ignore`, not `inherit`, and the reason cost half an hour.
 *
 * `launch.sh` starts Chrome in the background. An inherited stdio pipe is inherited by Chrome
 * too, and `execFileSync` waits for the pipe to close, not for the script to exit, so it waited
 * on a browser that was never going to exit. From the outside it looked exactly like the suites
 * being slow, which is what this file exists to fix.
 */
const daemon = await startTestDaemon();
process.env['TT_DAEMON_PORT'] = String(daemon.port);
process.env['TT_DAEMON_TOKEN'] = daemon.token;
// The two suites that kill things are told which installation is theirs. Without it they
// refuse to act rather than reaching for whatever daemon happens to be on the machine.
process.env['TT_DAEMON_HOME'] = daemon.home;
process.env['TT_DAEMON_PID'] = String(daemon.child.pid ?? '');
console.log(`  test daemon on ${String(daemon.port)}, home ${daemon.home}`);

for (const port of ports) startBrowser(port);

for (const name of first) report(await runSuite(name, BASE_PORT));
await pool(parallel, ports);

/**
 * Tidy up before the destructive suites, not only after everything.
 *
 * They kill the daemon and time how long it takes to come back. Left until the end, it comes
 * back holding every session the whole run created, and recovery takes long enough that the
 * check times out. That reads as the recovery being broken when it is the fixture being heavy.
 */
if (last.length > 0) sweep();

// Only now, with nothing else in flight to be taken down with the daemon.
for (const name of last) report(await runSuite(name, BASE_PORT));

// Anything a suite could not clean up itself, usually because it reloaded the page and lost the
// connection that would have done it. Sessions outlive the daemon now, so a leak here is a shell
// running on the machine until somebody notices.
sweep();

// The daemon and everything it owned. Its PTY host goes with it, which is safe precisely
// because nothing a person is using was ever in there.
try {
  daemon.child.kill('SIGTERM');
  /**
   * By port, not by home.
   *
   * `pkill -f <home>` matches nothing: the home is in the process's environment and `ps` shows
   * only the command line, which is identical for every daemon on the machine. Matching on it
   * would either kill nothing, which leaves a daemon holding the port, or be widened to the
   * command line, which would kill the one a person is using.
   */
  const holding = execFileSync('lsof', ['-t', '-i', `:${String(daemon.port)}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  for (const pid of holding.split('\n').filter(Boolean)) process.kill(Number(pid), 'SIGKILL');
} catch {
  /* already gone */
}
try {
  // Kept when something went wrong, because the daemon's log is the only evidence of why.
  if (daemon.state.restarts === 0) rmSync(daemon.home, { recursive: true, force: true });
  else console.log(`  kept ${daemon.home} for its daemon.log`);
} catch {
  /* a directory that could not be removed is not a failed run */
}

if (daemon.state.restarts > 0) {
  console.log(`  note: the test daemon restarted ${String(daemon.state.restarts)} time(s)`);
}

const pass = results.reduce((n, r) => n + r.pass, 0);
const fail = results.reduce((n, r) => n + r.fail, 0);
const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 3);
console.log('');
console.log(`  -----  ${String(pass)} passed, ${String(fail)} failed`);
console.log(
  `  -----  ${((Date.now() - started) / 1000).toFixed(0)}s total, ` +
    `${String(first.length)} first, ${String(parallel.length)} across ${String(width)} browsers, ` +
    `${String(last.length)} last`,
);
console.log(
  `  -----  slowest: ${slowest.map((r) => `${r.name} ${r.seconds.toFixed(0)}s`).join(', ')}`,
);
process.exit(fail === 0 ? 0 : 1);
