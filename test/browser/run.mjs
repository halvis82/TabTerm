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
  /**
   * Measures how long a tab takes to become usable, and how much work one change costs.
   *
   * Both are numbers about the product, and both become numbers about the machine the moment
   * thirty-nine suites across four browsers are competing for it: measured in a full parallel
   * run, a start screen that is usable in a hundred and fifty milliseconds reported twenty
   * seconds. A budget that has to be loosened until it passes under that load is a budget that
   * would not notice the product getting ten times slower.
   */
  'startup-cost',
  /**
   * Measures how often a pane changes size, which every other browser's work perturbs.
   *
   * Counting size changes over four seconds is the only way to tell a size that settles from one
   * that oscillates, and it is exactly the kind of measurement three other browsers on the same
   * machine make meaningless.
   */
  'steady-size',
  /**
   * These two are long round trips rather than measurements, and they time out under load.
   *
   * `undo-close` closes a pane, waits for the daemon to hold it, brings it back, moves one to
   * another tab and back again. Alone it takes thirteen seconds; beside three other browsers it
   * took a hundred and forty and ran out of patience partway. `start-screen-typing` sends a
   * thousand keystrokes one at a time. Raising their timeouts hides the problem in the good case
   * and does not fix the bad one; not competing does both.
   */
  'undo-close',
  'start-screen-typing',
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
 * `resilience` kills a PTY host, and it has to: no other check can show that a terminal outlives
 * the process holding it. It runs last because it also kills the daemon.
 *
 * It was opt-in for a long time, and the reason was real. The suites' daemon could not start a
 * host of its own, so it fell back to owning the PTYs itself and `ownHostPid()` found nothing;
 * the only host on the machine was the installed one, holding terminals somebody was working in.
 *
 * That is fixed, and the fix is why this can run by default. The socket path was over the
 * hundred byte limit a unix socket has, so the host never started under a temporary home. The
 * suites' daemon now has its own host, and the pid is read from the pointer that daemon writes
 * rather than assembled by matching on a process name. Confirmed by watching the installed
 * host's pid across a run: unchanged.
 */
const LAST = ['survives-restart', 'resilience'];

/**
 * Nothing is skipped by default any more.
 *
 * Kept as a mechanism rather than deleted, because a suite that must be excluded from the
 * **whole** run rather than merely from a phase is a distinction worth keeping: taking one out
 * of the phase list alone quietly promotes it into the parallel pool, where `resilience` once
 * killed a host while four browsers were using it.
 */
const SKIP = [];

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
/**
 * The suites a change to a hub file runs.
 *
 * Some files are not about one thing. `terminal-page.ts` is five thousand lines and touches the
 * layout, the start screen, the menus, focus, sizing and every message the daemon sends;
 * `server.ts` and `protocol.ts` are the same on the other side. Mapping one of those to the
 * suites it could break is mapping it to all of them, which is how `--changed` came to mean
 * "run everything" for the six files that change most, which is to say it meant nothing.
 *
 * So a hub file runs this instead: a spread across the load-bearing paths, chosen to be fast.
 * It is deliberately **not** a claim that nothing else can break. It is the inner loop, and the
 * protocol around it is what makes that safe: a full run is what closes a work package, and this
 * is what makes the twenty runs before it cost a minute instead of eight.
 *
 * See AGENTS/TESTING.md.
 */
const CORE = [
  'terminal',
  'layout',
  'start-screen-refresh',
  'pane-menu',
  'straight-to-view',
  'agent-favicon',
];

/**
 * Paths no browser suite can be affected by.
 *
 * The failure mode of this list is running too little, so it holds only things that genuinely
 * cannot reach a running page: prose, notes, and the repository's own furniture.
 */
const IRRELEVANT = [
  'docs/',
  'AGENTS/',
  'README',
  'package.json',
  'package-lock.json',
  '.gitignore',
  'eslint.config',
  'vitest.config',
  '.prettier',
  'tsconfig',
];

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
  ['daemon/src/project-', ['project-trust', 'launched-pane']],
  ['daemon/src/notify', ['notifications']],
  ['daemon/src/attention-notices', ['agent-favicon', 'notifications']],
  ['daemon/src/file-slice', ['resume-and-tabs']],
  ['extension/src/terminal/themes', ['light-mode', 'light-panels']],
  ['extension/src/terminal/status-machine', ['agent-favicon']],
  ['extension/src/terminal/wake-redraw', ['steady-size']],
  ['extension/src/terminal/resize-storm', ['steady-size']],
  ['extension/src/terminal/screen-content', ['start-screen-refresh', 'straight-to-view']],
  ['extension/src/terminal/panes', ['layout', 'workspace', 'steady-size']],
  ['extension/src/transport/', ['resilience', 'reattach']],
  ['extension/src/service-worker', ['sessions', 'tab-persistence']],
  ['extension/src/chrome/', ['notifications', 'sessions']],
  ['scripts/', CORE],
  ['extension/public/terminal.html', ['light-mode', 'light-panels', 'palette', 'command-panel']],

  /**
   * The hub files. See `CORE` for why these are a spread rather than a claim.
   */
  ['extension/src/terminal/terminal-page.ts', CORE],
  ['daemon/src/server.ts', CORE],
  ['daemon/src/main.ts', CORE],
  ['daemon/src/session-manager.ts', [...CORE, 'sessions', 'pane-close']],
  ['shared/src/protocol.ts', CORE],
  ['shared/src/', CORE],
];

/**
 * What has changed, either in the working tree or since a branch point.
 *
 * `--changed` is for the loop you are in right now, so it reads the working tree. `--since <ref>`
 * is for a branch about to be merged, where the working tree is clean and the change is every
 * commit on top of the base.
 */
function changedPaths(since) {
  if (since) {
    return execFileSync('git', ['diff', '--name-only', `${since}...HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return execFileSync('git', ['status', '--porcelain', '-uall'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

function changedSuites(since) {
  const changed = changedPaths(since);
  if (changed.length === 0) return [];

  const picked = new Set();
  for (const path of changed) {
    if (path.startsWith('test/browser/suites/')) {
      picked.add(path.replace('test/browser/suites/', '').replace(/\.mjs$/, ''));
      continue;
    }
    /**
     * Nothing a browser suite can see.
     *
     * Documentation, notes, the unit tests, and the repository's own furniture. A unit test is
     * on this list because `npm run check` is what runs it, and running forty browser suites
     * because somebody edited an assertion in a unit test is the behavior this exists to stop.
     */
    if (IRRELEVANT.some((prefix) => path.startsWith(prefix)) || path.endsWith('.test.ts')) {
      continue;
    }
    /**
     * The harness itself. Everything, and it says so rather than looking like a miss.
     *
     * A change to how suites are driven changes every suite, and there is no smaller honest
     * answer than all of them.
     */
    if (path.startsWith('test/browser/') && !path.startsWith('test/browser/suites/')) {
      console.log(`  ${path} is the harness itself, so running everything`);
      return null;
    }
    const hit = COVERS.find(([prefix]) => path.startsWith(prefix));
    if (!hit) {
      // Named, because "something is unmapped" is not something anybody can act on.
      console.log(`  ${path} is not in the coverage table, so running everything`);
      return null;
    }
    for (const suite of hit[1]) picked.add(suite);
  }
  return [...picked];
}

function suiteNames() {
  let wanted = only;
  const sinceArg = args.find((a) => a.startsWith('--since='));
  if (args.includes('--changed') || sinceArg) {
    const picked = changedSuites(sinceArg ? sinceArg.slice('--since='.length) : null);
    if (picked === null) {
      // The reason was printed where it was found, naming the file.
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

/**
 * Say what would run, and stop.
 *
 * The whole point of a narrowed run is knowing what it narrowed to before waiting for it, and
 * the only way to find that out was to start one, which takes as long as the thing being avoided.
 */
function maybeDryRun(names) {
  if (!args.includes('--dry')) return;
  console.log(`  ${String(names.length)} suite(s): ${names.join(', ')}`);
  process.exit(0);
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
    child.on('close', (code) => {
      const lines = out.split('\n');
      const failures = lines.filter((l) => l.startsWith('  FAIL'));
      /**
       * A suite that threw is a failed suite, whatever it managed to check first.
       *
       * The tally counted PASS and FAIL lines only, so a suite that crashed halfway reported
       * everything it had got through and nothing about the half it never reached. One did
       * exactly that and the run said zero failed.
       */
      if (code !== 0) {
        const why = lines
          .filter((l) => /Error|error:/.test(l))
          .slice(0, 2)
          .join(' ')
          .trim();
        failures.push(`  FAIL  ${name} exited ${String(code)}${why ? `: ${why}` : ''}`);
      }
      resolve({
        name,
        seconds: (Date.now() - started) / 1000,
        pass: lines.filter((l) => l.startsWith('  PASS')).length,
        fail: failures.length,
        failures,
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

/**
 * How many pseudo-terminal device nodes exist. Reported before and after every run.
 *
 * macOS caps these at `kern.tty.ptmx_max`, and once the cap is reached **nothing on the machine
 * can open a terminal**: not this product, not iTerm, not anything. That happened on 2026-09-02.
 *
 * Worth knowing before reading the number: a node is not the same as a process. macOS keeps the
 * `/dev/ttysNNN` entry for a while after whatever held it is gone, and reclaims it on its own
 * schedule, so this count runs well ahead of what is actually being used and comes down slowly.
 * It is the right number for headroom against the cap, and the wrong number for blame. For blame
 * see `strayProcesses`.
 */
function ptyCount() {
  try {
    return Number(
      execFileSync('bash', ['-c', 'ls /dev/ttys* 2>/dev/null | wc -l'], {
        encoding: 'utf8',
      }).trim(),
    );
  } catch {
    return -1;
  }
}

/**
 * Anything this run started that is somehow still running.
 *
 * This is the number that means we did something wrong, and it should always be zero. The pty
 * host detaches itself on purpose, so it is not in our process group and will not be swept up by
 * a signal to the group. It has to be found by name and by the home directory this run invented.
 */
function strayProcesses() {
  try {
    // `-E` prints each process's environment, which is the only place the home this run
    // invented appears: the host takes its socket path from `TABTERM_HOME`, not from argv.
    const out = execFileSync(
      'bash',
      [
        '-c',
        `ps -E -o pid,command | grep -F ${JSON.stringify(daemon.home)} | grep -v grep || true`,
      ],
      { encoding: 'utf8' },
    ).trim();
    return out ? out.split('\n').length : 0;
  } catch {
    return 0;
  }
}
const ptysBefore = ptyCount();

/**
 * Refuse to start when the machine is nearly out, rather than being the thing that finishes it.
 *
 * A full run needs somewhere around seventy, and the failure at the end of the supply is not a
 * failing test: it is a laptop that cannot open a terminal in any application until it restarts,
 * reported as `posix_spawnp failed` with nothing pointing at the cause. Costing somebody a run is
 * a much smaller thing than costing them their terminals, so this errs early.
 */
{
  const cap = Number(
    execFileSync('sysctl', ['-n', 'kern.tty.ptmx_max'], { encoding: 'utf8' }).trim(),
  );
  if (ptysBefore > 0 && cap - ptysBefore < 120) {
    console.error(`  ${String(ptysBefore)} of ${String(cap)} ptys are already gone.`);
    console.error('  A run needs about 70, and running out stops every terminal on this machine.');
    console.error('  Raise the cap or restart:  sudo sysctl -w kern.tty.ptmx_max=999');
    process.exit(1);
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
 * A port for this run's daemon.
 *
 * **Not** by binding port zero and reading back what was given. That is the obvious way and it
 * loses a race: the port is released the moment it is read, and the operating system hands it
 * straight to something else before the daemon gets there. Every run began with a failed bind.
 *
 * A random port in a quiet range, checked by asking who is listening, is uglier and works. A
 * collision is still possible and is answered by trying another, which is why the retry exists.
 */
function pickPort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 7400 + Math.floor(Math.random() * 400);
    try {
      const held = execFileSync('lsof', ['-t', '-i', `:${String(port)}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (held === '') return port;
    } catch {
      // `lsof` exits non-zero when nothing holds it, which is the answer we want.
      return port;
    }
  }
  return 7400 + Math.floor(Math.random() * 400);
}

function startTestDaemon() {
  const home = mkdtempSync(join(tmpdir(), 'tabterm-suite-home-'));
  const port = Number(process.env['TT_DAEMON_PORT'] ?? '') || pickPort();
  const state = { child: null, pid: 0, stopping: false, restarts: 0, port, groups: [] };

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
    /**
     * Its own process group, so everything it starts can be ended with it.
     *
     * The daemon spawns a PTY host, the host spawns shells, and each shell holds a pseudo
     * terminal. Killing the daemon alone orphans all of that, and macOS never gives a pty back
     * until the machine restarts: one full run leaked sixty-nine of them against a cap of 511.
     * `detached` makes the daemon a group leader, and a negative pid kills the group.
     */
    const child = spawn(process.execPath, [join(ROOT, 'daemon', 'dist', 'main.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        TABTERM_HOME: home,
        TABTERM_PORT: String(state.port),
        // A suite that drives an agent's hooks is asking what the daemon does, not asking to
        // interrupt whoever is running the tests. See `QUIET` in daemon/src/server.ts.
        TABTERM_NO_NOTIFICATIONS: '1',
      },
      stdio: ['ignore', log, log],
      detached: true,
    });
    state.child = child;
    state.pid = child.pid ?? 0;
    // Every group this run has ever started, because a restarted daemon leaves its old group
    // behind and every shell in it holds a pty the machine will not hand out again.
    if (child.pid) state.groups.push(child.pid);
    child.on('exit', (code, signal) => {
      if (state.stopping) return;
      state.restarts++;
      /**
       * Said out loud, with the time, because a daemon that dies takes a suite down with it and
       * the suite reports a product bug. A run that ends with more restarts than the suites that
       * kill it deliberately used to give no way at all to find out which death was which.
       */
      console.log(
        `  daemon exited (${String(code ?? signal)}) at ${new Date().toISOString().slice(11, 19)}, restart ${String(state.restarts)}`,
      );
      /**
       * A port that turned out to be taken is answered with a different one.
       *
       * Asking the operating system for a free port and then binding it a moment later is a
       * race: something else can take it in between. Retrying on the same port loses that race
       * repeatedly and every suite in the run fails for reasons that look like product bugs.
       */
      if (code === 1 && state.restarts <= 3) {
        state.port = pickPort();
        // Told to the suites as well, or they go looking for the daemon on the old one: the
        // two that kill processes find nothing and report that they have no daemon of their own.
        process.env['TT_DAEMON_PORT'] = String(state.port);
        console.log(`  port was taken, trying ${String(state.port)}`);
      }
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

  /**
   * It writes its token on startup, and the browsers need it to authenticate.
   *
   * Waited for by **content**, not by existence. A file exists the instant it is created, which
   * is before anything has been written into it, so reading it then yields an empty string. The
   * browsers were then pointed at this daemon with no token, every authentication was refused,
   * and the run failed with every page saying the daemon was not responding. Intermittent,
   * because it depends on how the two processes are scheduled, which is why it presented as the
   * harness being unreliable rather than as anything with a cause.
   */
  const tokenFile = join(home, '.local', 'state', 'tabterm', 'token');
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (existsSync(tokenFile)) {
      const written = readFileSync(tokenFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(written)) break;
    }
    if (Date.now() > deadline)
      throw new Error(`the test daemon never wrote a usable token; see ${home}/daemon.log`);
    execFileSync('sleep', ['0.2']);
  }
  return {
    home,
    get port() {
      return state.port;
    },
    child,
    token: readFileSync(tokenFile, 'utf8').trim(),
    state,
  };
}

/**
 * Every browser this run started, so it can be ended again.
 *
 * `launch.sh` uses `nohup ... & disown`, deliberately: a Chrome tied to this process would die
 * with it mid-suite. The cost is that nothing holds a handle to it, so it has to be found the
 * way it was made, by the profile directory that is unique to its port.
 */
const browserPorts = [];

function startBrowser(port) {
  browserPorts.push(port);
  execFileSync('bash', [join(HERE, 'launch.sh')], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TT_CDP_PORT: String(port) },
  });
  /**
   * Loud, because this is the step that keeps the suites off somebody's real daemon.
   *
   * It was `stdio: 'ignore'`, so when it silently failed to point the browser anywhere the run
   * carried on against the installed daemon on 7377 and nothing said so. Sessions the suites
   * created went into the daemon somebody was working in, which is the exact thing the
   * temporary home and the separate port exist to prevent.
   */
  const pointed = execFileSync(process.execPath, [join(HERE, 'load-extension.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TT_CDP_PORT: String(port) },
  });
  if (!pointed.includes('pointed at the test daemon')) {
    console.error(`  the browser on ${String(port)} was not pointed at this run's daemon:`);
    console.error(`  ${pointed.trim().split('\n').join('\n  ')}`);
    process.exit(1);
  }
}

const started = Date.now();

if (process.env['TT_SKIP_BUILD'] !== '1') {
  execFileSync('npm', ['run', '--silent', 'build'], { cwd: ROOT, stdio: 'ignore' });
}
const names = suiteNames();
// Kept in the declared order, not alphabetical: which phase a suite is in is load bearing.
maybeDryRun(names);

const first = FIRST.filter((n) => names.includes(n));
const last = LAST.filter((n) => names.includes(n));
const parallel = names.filter((n) => !SERIAL.includes(n));

/**
 * A debugging port for each browser this run drives.
 *
 * Random by default rather than a fixed 9223, so two runs can happen at once: one somebody is
 * driving by hand while another finishes in the background, or two agents working on separate
 * branches. Everything else about a run is already its own: the daemon picks its own port and
 * its own `TABTERM_HOME`, and every profile directory is temporary. This was the last thing
 * shared, and sharing it meant the second run attached to the first run's browsers.
 *
 * Set `TT_CDP_PORT` to pin it, which is what to do when something has to be watched by hand.
 */
const BASE_PORT =
  Number(process.env['TT_CDP_PORT'] ?? '') || 9300 + Math.floor(Math.random() * 300) * 10;
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
const daemon = startTestDaemon();

/**
 * Installed the moment there is something to clean up, and before a single suite runs.
 *
 * This was at the bottom of the file, after the top level `await` that runs everything, so it
 * was only ever registered once there was nothing left to clean up. Interrupting a run left its
 * daemon and ten Chrome processes behind, which is the exact failure the handler was written to
 * prevent, and it looked handled because the code was plainly there.
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    console.log('\n  interrupted: ending what this run created');
    endEverythingThisRunMade();
    process.exit(130);
  });
}
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
endEverythingThisRunMade();
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

/**
 * Everything this run made, ended, whatever happens.
 *
 * Interrupting a run is normal and must be safe. It was not: a killed run left its sessions
 * alive forever, because the reap policy keeps anything no browser has reported on, which is
 * exactly the state a dead test browser leaves behind. Dozens of interrupted runs filled the
 * machine's pty table.
 *
 * Safe to be blunt here precisely because this daemon is the suites' own: it was created by
 * this process, in a temporary home, and holds nothing a person is using.
 */
function endEverythingThisRunMade() {
  /**
   * The browsers, which nothing else will take with it.
   *
   * They are detached on purpose and so survive this process, an interrupt included. Left
   * behind they are ten idle Chrome processes per run holding a few hundred megabytes, and the
   * only thing that ever collected them was the next run happening to reuse the same port.
   */
  for (const port of browserPorts) {
    try {
      execFileSync('pkill', ['-f', `user-data-dir=/tmp/tt-chrome-headless-${String(port)}`], {
        stdio: 'ignore',
      });
    } catch {
      // pkill exits non-zero when it matched nothing, which is the outcome we wanted.
    }
  }
  try {
    daemon.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  /**
   * The whole group, which is the daemon, its PTY host, and every shell they started.
   *
   * Killing the daemon alone leaves the rest orphaned, and every orphaned shell holds a pseudo
   * terminal that macOS will not hand out again until the machine restarts.
   */
  for (const pid of daemon.state.groups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* that group is already gone */
    }
  }
  for (const port of [daemon.port]) {
    try {
      const held = execFileSync('lsof', ['-t', '-i', `:${String(port)}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      for (const pid of held.split('\n').filter(Boolean)) process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* nothing listening */
    }
  }
  /**
   * The PTY host, by the pid it wrote down, because nothing else here reaches it.
   *
   * It detaches on purpose and its socket and lock are not under this run's home: the home a
   * temporary directory produces is long enough to push a unix socket path over the hundred
   * byte cap, so the host moves both to the temporary directory and the daemon writes down
   * where they went. Every mechanism below looks under the home, so for weeks each run left a
   * host behind: 133 of them were counted on 2026-09-04, holding 800 MB between them.
   */
  const host = hostPidUnder(daemon.home);
  if (host) {
    try {
      process.kill(host, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  /**
   * Anything still holding a file under this run's home.
   *
   * The PTY host **detaches itself on purpose**, which is the entire point of it: it has to
   * survive its daemon being replaced. That also means it escapes the daemon's process group,
   * so killing the group never reached it, and every shell it held kept its pseudo terminal.
   * One run left 718 of them behind, against a machine limit of 999.
   *
   * Its socket, its lock and its scrollback all live under this run's temporary home, and
   * nothing else on the machine has that directory open, so this finds exactly the processes
   * this run is responsible for and nothing else.
   */
  try {
    const holding = execFileSync('lsof', ['-t', '+D', daemon.home], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    for (const pid of holding.split('\n').filter(Boolean)) {
      if (Number(pid) === process.pid) continue;
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing had it open */
  }
}

/**
 * This run's PTY host, from the pointer its daemon wrote.
 *
 * Read rather than assembled, and read from the pointer rather than from a fixed path, because
 * the host moves its socket and its lock to the temporary directory when the home makes the
 * natural path too long for a unix socket. Matching on the process name instead was the single
 * most destructive line this harness ever had: it matched every host on the machine, which is
 * every terminal a person has open.
 */
function hostPidUnder(home) {
  try {
    const pointer = join(home, '.local/state/tabterm/ptyhost.where');
    const lockPath = readFileSync(pointer, 'utf8').trim().split('\n')[1];
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * A restart per suite that kills the daemon is the point, not a fault.
 *
 * `survives-restart` and `resilience` each kill it deliberately, so a clean full run reports
 * two. More than that means something is falling over, and for two days it meant thirteen: the
 * agent bridge was on a hardcoded port, so a second daemon on the machine died on a number that
 * had nothing to do with the one it had been given.
 *
 * Counted from the suites that actually ran, because a run of one suite should not be warned at
 * for the restarts of suites it did not include.
 */
const killers = ['survives-restart', 'resilience'].filter((n) => names.includes(n)).length;
if (daemon.state.restarts > killers) {
  console.log(
    `  WARNING: the test daemon restarted ${String(daemon.state.restarts)} times, expected ${String(killers)}`,
  );
} else if (daemon.state.restarts > 0) {
  console.log(
    `  note: the daemon restarted ${String(daemon.state.restarts)} time(s), which is the suites that kill it doing their job`,
  );
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
/**
 * A leak, named, at the end of every run.
 *
 * macOS caps pseudo-terminals at `kern.tty.ptmx_max`, and once that is reached nothing on the
 * machine can open a terminal: not this product, not iTerm. Discovering that days later on a
 * laptop that could no longer open a shell is what made this worth printing every time.
 */
// A moment to settle, so anything shutting down has finished doing so before it is counted.
execFileSync('sleep', ['2']);
const ptysAfter = ptyCount();
const cap = Number(
  execFileSync('sysctl', ['-n', 'kern.tty.ptmx_max'], { encoding: 'utf8' }).trim(),
);
console.log(`  -----  ptys ${String(ptysBefore)} -> ${String(ptysAfter)} of ${String(cap)}`);

// Two different failures, printed differently because they call for different things.
const stray = strayProcesses();
if (stray > 0) {
  console.log(`  -----  WARNING: ${String(stray)} process(es) from this run are still alive`);
}
/**
 * A budget the suites may not quietly grow past.
 *
 * The rise in this count over a run is very nearly the number of terminals the run opened, and
 * that is the number that matters: macOS hands out a pseudo-terminal once and gives it back on
 * its own unhurried schedule, so a run that opens two hundred exhausts the machine however
 * politely it ends every one of them.
 *
 * A budget rather than a limit, because the honest fix is fewer tabs in the suites and this
 * cannot do that for them. What it can do is make growth visible on the run that causes it,
 * instead of on the afternoon somebody's laptop stops being able to open a terminal.
 */
const SESSION_BUDGET = 90;
const opened = ptysAfter - ptysBefore;
if (opened > SESSION_BUDGET) {
  console.log(
    `  -----  WARNING: this run opened about ${String(opened)} terminals, budget ${String(SESSION_BUDGET)}`,
  );
  console.log('  -----  suites should share a tab rather than opening one per check');
}

if (cap - ptysAfter < 150) {
  console.log(
    `  -----  WARNING: only ${String(cap - ptysAfter)} ptys left before nothing on this machine`,
  );
  console.log('  -----  can open a terminal. Raise it: sudo sysctl -w kern.tty.ptmx_max=999');
}

process.exit(fail === 0 ? 0 : 1);
