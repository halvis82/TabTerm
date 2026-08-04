// node-pty ships a `spawn-helper` binary that sets up the controlling terminal. The npm
// tarball extraction does not preserve its executable bit on macOS, so every PTY spawn fails
// with a bare "posix_spawnp failed" that names no file and is easy to misdiagnose.
//
// Measured, not theoretical: it reproduces on every fresh install. See docs/13-packaging.md.
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let root;
try {
  root = dirname(require.resolve('node-pty/package.json'));
} catch {
  process.exit(0); // Not installed yet, nothing to repair.
}

let repaired = 0;
for (const platform of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(root, 'prebuilds', platform, 'spawn-helper');
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
    repaired++;
  }
}

if (repaired > 0) {
  console.log(`postinstall: made ${repaired} node-pty spawn-helper binary(ies) executable`);
}
