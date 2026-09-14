// Run a command with a Node that can open the database, whatever PATH happens to start with.
//
// `install.sh` has always picked its own Node. The test scripts trusted PATH, so on a machine
// whose first Node is 20 the unit suites failed at collection and the browser runner spawned a
// daemon that died opening its database, both of which read as a broken working tree.
//
// This does not replace the runtime for the whole shell. It puts the chosen Node's directory
// first on PATH for the child, which is what reaches `vitest`'s own shebang and the runner's
// `process.execPath` when it spawns the daemon.
//
// Usage: node scripts/with-node.mjs <command> [args...]
import { spawn } from 'node:child_process';
import { NO_NODE_MESSAGE, pickNode } from './pick-node.mjs';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: node scripts/with-node.mjs <command> [args...]');
  process.exit(2);
}

const chosen = pickNode();
if (!chosen) {
  console.error(NO_NODE_MESSAGE);
  process.exit(1);
}

// Silent when PATH was already right, which is the normal case and does not need a line.
if (chosen.path !== process.execPath) {
  console.log(`node ${chosen.version} from ${chosen.dir} (PATH had ${process.version})`);
}

const child = spawn(argv[0], argv.slice(1), {
  stdio: 'inherit',
  env: { ...process.env, PATH: `${chosen.dir}:${process.env['PATH'] ?? ''}` },
});

/**
 * An interrupt has to reach the run, not only this wrapper.
 *
 * A browser run reaps the sessions it created when it is interrupted, and that only happens if
 * the signal arrives. A terminal sends it to the whole process group, so the child usually has it
 * already; forwarding covers the case where this process is signalled on its own.
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}

child.on('error', (e) => {
  console.error(`could not run ${argv[0]}: ${String(e)}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  // A child killed by a signal exits with 128 + n, the convention every shell uses.
  process.exit(signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 0) : (code ?? 0));
});
