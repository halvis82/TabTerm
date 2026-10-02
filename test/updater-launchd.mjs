// Optional macOS integration check. Only its unique job and temporary files are touched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { updaterPlist } from '../scripts/updater/launchd.mjs';

assert.equal(process.platform, 'darwin', 'This check requires a macOS login session');
const directory = mkdtempSync(join(tmpdir(), 'tabterm-updater-probe-'));
const label = `com.tabterm.updater-test.${randomUUID()}`;
const domain = `gui/${process.getuid()}`;
const worker = join(directory, 'helper.mjs');
const plist = join(directory, 'helper.plist');
const owned = join(directory, 'owned.json');
const result = join(directory, 'result.json');
writeFileSync(
  worker,
  `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const owned = ${JSON.stringify(owned)};
if (existsSync(owned)) {
  const prior = JSON.parse(readFileSync(owned));
  let alive = true;
  try { process.kill(prior.child, 0); } catch { alive = false; }
  writeFileSync(${JSON.stringify(result)}, JSON.stringify({ restarted: true, priorChildAlive: alive }));
} else {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(owned, JSON.stringify({ helper: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
}
`,
);
writeFileSync(plist, updaterPlist(process.execPath, worker, directory, false, label));
async function waitForFile(path, milliseconds) {
  const until = Date.now() + milliseconds;
  while (!existsSync(path) && Date.now() < until) await wait(100);
  assert.ok(existsSync(path), `Job did not create ${path}`);
  return JSON.parse(readFileSync(path));
}
try {
  execFileSync('/bin/launchctl', ['bootstrap', domain, plist]);
  const processes = await waitForFile(owned, 10_000);
  process.kill(processes.helper, 'SIGKILL');
  const outcome = await waitForFile(result, 40_000);
  assert.deepEqual(outcome, { restarted: true, priorChildAlive: false });
  console.log('Updater LaunchAgent restarted after interruption and reaped its previous child.');
} finally {
  try {
    execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  } catch {
    /* no loaded job */
  }
  rmSync(directory, { recursive: true, force: true });
}
