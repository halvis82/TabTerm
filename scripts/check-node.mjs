// Says which Node the suites and the daemon will actually run on, and fails when there is none.
//
// This used to assert about the process it ran in, which was the wrong question once the scripts
// began choosing their own runtime: `npm run verify` refused on a machine where every suite would
// have passed. What matters is whether a usable Node exists, and which one gets picked.
//
// See scripts/pick-node.mjs and docs/adr/0015-node-sqlite-over-native.md.
import { NO_NODE_MESSAGE, pickNode } from './pick-node.mjs';

const chosen = pickNode();
if (!chosen) {
  console.error(NO_NODE_MESSAGE);
  process.exit(1);
}

const same = chosen.path === process.execPath;
console.log(
  `node ${chosen.version} has node:sqlite` + (same ? ' (this one)' : ` at ${chosen.dir}`),
);
