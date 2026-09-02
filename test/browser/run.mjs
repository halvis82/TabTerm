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
import { readdirSync } from 'node:fs';
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
const LAST = ['survives-restart', 'resilience'];

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
