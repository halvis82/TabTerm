// Which Node the daemon and the suites can actually run on.
//
// node:sqlite arrived in Node 22. On an older runtime everything typechecks, everything builds,
// and the failure arrives only when the database is opened, which is a long way from the cause.
// See docs/adr/0015-node-sqlite-over-native.md.
//
// `install.sh` has made this choice since the beginning and nothing else did, so `npm run check`
// on a machine whose PATH starts with Node 20 failed twenty suites at collection and read as a
// broken working tree rather than as a wrong runtime.
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * The same candidates the installer tries, in the same order.
 *
 * Whatever is on PATH first, so a machine that is already right pays nothing and keeps using the
 * Node its author chose, then the Homebrew versions newest first, then the Intel prefix.
 */
const CANDIDATES = [
  process.env['TABTERM_NODE'],
  process.execPath,
  '/opt/homebrew/opt/node@24/bin/node',
  '/opt/homebrew/opt/node@23/bin/node',
  '/opt/homebrew/opt/node@22/bin/node',
  '/usr/local/bin/node',
];

/** Whether this binary has the built-in SQLite, asked of the binary rather than inferred. */
function hasSqlite(nodePath) {
  try {
    execFileSync(nodePath, ['-e', 'require("node:sqlite")'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first candidate that can open a database, with its version, or null when there is none.
 *
 * Asked by running it, never by parsing a version out of a path. The version in a Homebrew path
 * is the formula rather than the runtime, and a path is not evidence of what is installed at it.
 */
export function pickNode() {
  for (const candidate of CANDIDATES) {
    if (!candidate) continue;
    if (!hasSqlite(candidate)) continue;
    const version = execFileSync(candidate, ['-v'], { encoding: 'utf8' }).trim();
    return { path: candidate, dir: dirname(candidate), version };
  }
  return null;
}

/** What to say when there is none. One message, so both entry points say the same thing. */
export const NO_NODE_MESSAGE =
  `\nTabTerm needs Node 22 or newer for its built-in SQLite.\n` +
  `  running: ${process.version}\n` +
  `  fix:     brew install node@24\n` +
  `           Nothing else is needed: the scripts find it once it is installed.\n`;
