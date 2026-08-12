#!/usr/bin/env node
// Install or remove TabTerm's agent CLI hooks, from the command line.
//
// A thin wrapper. The implementation lives in daemon/src/agent-hooks.ts, which is also what the
// settings switch in the extension calls, so the two paths cannot disagree about what a hook
// looks like or which events are wired.
//
// See docs/09-agent-integration.md.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
// The installed copy first, since that is the one a user has. The build output is the fallback
// for a working tree that has not been installed yet.
const candidates = [
  join(homedir(), '.local', 'libexec', 'tabterm', 'agent-hooks.mjs'),
  join(repo, 'daemon', 'dist', 'agent-hooks-cli.js'),
];
const daemon = candidates.find((p) => existsSync(p));

if (!daemon) {
  console.error('No built daemon found. Run: npm run build');
  process.exit(1);
}

const action = process.argv.includes('--remove')
  ? 'remove'
  : process.argv.includes('--status')
    ? 'status'
    : 'install';

const run = spawnSync(process.execPath, [daemon, action], { stdio: 'inherit' });
process.exit(run.status ?? 1);
