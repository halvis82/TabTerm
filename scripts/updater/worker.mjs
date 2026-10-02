import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import {
  parseCompanionRelease,
  compatibilityIssue,
  compareVersions,
} from '../../shared/src/updates.ts';
import { download } from './network.mjs';
import { readJson, writeJson, activateUpdate } from './state.mjs';
import { extractSource } from './archive.mjs';
import { queryDaemon } from './socket.mjs';

export async function runWorker(home = homedir(), recover = false, adapters = {}) {
  const query = adapters.queryDaemon ?? queryDaemon;
  const fetchBytes = adapters.download ?? download;
  const state = join(home, '.local/state/tabterm');
  const updates = join(state, 'updates');
  const installed = join(home, '.local/libexec/tabterm');
  const interrupted = readJson(join(updates, 'status.json'));
  const lockOwner = readJson(join(updates, 'worker.lock/owner.json'));
  if (lockOwner?.pid) {
    let alive = true;
    try {
      process.kill(lockOwner.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) throw new Error('Another updater is running');
    if (interrupted?.phase === 'installing') recover = true;
    if (recover || interrupted?.phase === 'preparing')
      rmSync(join(updates, 'worker.lock'), { recursive: true, force: true });
  }
  const request = readJson(join(updates, 'request.json'));
  if (!request) throw new Error('Missing update request');
  const release = parseCompanionRelease(request.release);
  const incompatibility = compatibilityIssue(release);
  if (incompatibility) throw new Error(incompatibility);
  const transaction = readJson(join(updates, 'transaction.json'));
  const prior = recover ? transaction?.prior : readJson(join(installed, 'installation.json'));
  if (!prior || (!recover && compareVersions(release.version, prior.version) <= 0))
    throw new Error('Update must be newer than the installed companion');
  const lock = join(updates, 'worker.lock');
  try {
    mkdirSync(lock);
  } catch {
    throw new Error('Another update or interrupted update needs attention');
  }
  writeJson(join(lock, 'owner.json'), { pid: process.pid });
  const journalFile = join(updates, 'status.json');
  const journal = (phase, message = '') =>
    writeJson(journalFile, {
      phase,
      version: release.version,
      previousVersion: prior.version,
      message,
      updatedAt: Date.now(),
      pid: process.pid,
    });
  const stage = join(updates, 'staging');
  const backupDir = join(updates, 'previous');
  const token = readFileSync(join(state, 'token'), 'utf8').trim();
  const port = request.port ?? prior.port ?? 7377;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid companion port');
  const env = {
    ...process.env,
    PATH: `${dirname(prior.node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TABTERM_NODE: prior.node,
    TABTERM_COMPANION_UPDATE: '1',
  };
  const run =
    adapters.run ??
    ((command, args, cwd = stage) =>
      new Promise((resolveRun, reject) => {
        // launchd must own the entire build group so a crashed helper cannot leave an
        // installer modifying files while recovery starts. Never detach these children.
        const child = spawn(command, args, { cwd, env, stdio: 'ignore' });
        const timer = setTimeout(
          () => {
            // Exit the job so launchd reaps its whole process group. The journal remains
            // available for recovery, rather than racing rollback against a hung installer.
            const activating = readJson(journalFile)?.phase === 'installing';
            if (!activating)
              journal('error', 'The update build timed out. Your installation is unchanged.');
            process.exit(activating ? 1 : 0);
          },
          15 * 60 * 1000,
        );
        child.on('error', () => {
          clearTimeout(timer);
          reject(new Error('Could not run the update build tool'));
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          code === 0
            ? resolveRun()
            : reject(
                new Error(
                  'Update build or installer failed. Check Node, npm and Xcode Command Line Tools.',
                ),
              );
        });
      }));
  const paths = [
    installed,
    join(home, 'Library/LaunchAgents/com.tabterm.daemon.plist'),
    join(
      home,
      'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tabterm.host.json',
    ),
    join(home, '.local/share/tabterm/tabterm-integration.zsh'),
  ];
  let baseline = recover ? transaction?.baseline : null;
  const healthy = async (version) => {
    for (let i = 0; i < 30; i++) {
      try {
        const h = await query(port, token);
        if (h.version === version && h.durable && h.hostInstance === baseline.hostInstance)
          return true;
      } catch {
        /* restart in progress */
      }
      await wait(500);
    }
    return false;
  };
  const restore = async () => {
    await run(
      '/bin/launchctl',
      ['bootout', `gui/${process.getuid()}/com.tabterm.daemon`],
      home,
    ).catch(() => {});
    for (const [i, path] of paths.entries()) {
      rmSync(path, { recursive: true, force: true });
      const copy = join(backupDir, String(i));
      if (existsSync(copy)) {
        mkdirSync(dirname(path), { recursive: true });
        cpSync(copy, path, { recursive: true });
      }
    }
    for (let i = 0; i < 20; i++) {
      try {
        await run('/bin/launchctl', ['print', `gui/${process.getuid()}/com.tabterm.daemon`], home);
        await wait(250);
      } catch {
        break;
      }
    }
    await run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, paths[1]], home);
  };
  try {
    if (recover) {
      if (!baseline?.hostInstance || !existsSync(join(backupDir, '0/installation.json')))
        throw new Error('Recovery backup is missing');
      await restore();
      if (!(await healthy(prior.version))) {
        journal('manual');
        throw new Error('Recovery health check failed');
      }
      journal('rolled-back');
      return;
    }
    await activateUpdate({
      journal,
      prepare: async () => {
        baseline = await query(port, token);
        if (!baseline.durable || !baseline.hostInstance)
          throw new Error('A durable terminal service is required before updating');
        const bytes = await fetchBytes(release.source.url, release.source.bytes);
        if (
          bytes.length !== release.source.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== release.source.sha256
        )
          throw new Error('The companion download failed verification');
        rmSync(stage, { recursive: true, force: true });
        mkdirSync(stage, { recursive: true, mode: 0o700 });
        extractSource(bytes, stage);
        if (readJson(join(stage, 'package.json'))?.version !== release.version)
          throw new Error('Downloaded source version does not match the release');
        // Rollback cannot safely undo a live database migration. Such releases use manual setup.
        const dbHash = createHash('sha256')
          .update(readFileSync(join(stage, 'daemon/src/database.ts')))
          .digest('hex');
        if (dbHash !== prior.databaseSha256)
          throw new Error('This release changes database code and needs a manual upgrade');
        await run(join(dirname(prior.node), 'npm'), ['ci', '--no-audit', '--no-fund']);
        await run(join(dirname(prior.node), 'npm'), ['run', 'typecheck']);
        await run(join(dirname(prior.node), 'npm'), ['run', 'build']);
        const ptyVersion = readJson(join(stage, 'node_modules/node-pty/package.json'))?.version;
        if (ptyVersion !== readJson(join(installed, 'node_modules/node-pty/package.json'))?.version)
          throw new Error(
            'This release changes terminal native dependencies and needs a manual upgrade',
          );
        await run(prior.node, [
          'scripts/build-app-bundle.mjs',
          '--adopt-runtime',
          join(installed, 'TabTerm.app/Contents/MacOS/node'),
        ]);
        // Installer must use the already prepared files, with no build or prompts during activation.
        if (
          !readFileSync(join(stage, 'scripts/install.sh'), 'utf8').includes(
            'TABTERM_COMPANION_UPDATE',
          )
        )
          throw new Error('Release installer does not support safe updates');
      },
      backup: async () => {
        rmSync(backupDir, { recursive: true, force: true });
        mkdirSync(backupDir, { mode: 0o700 });
        for (const [i, path] of paths.entries())
          if (existsSync(path)) cpSync(path, join(backupDir, String(i)), { recursive: true });
        writeJson(join(updates, 'transaction.json'), { prior, baseline });
        const h = await query(port, token, { t: 'prepare-companion-update' });
        if (!h.durable || h.hostInstance !== baseline.hostInstance)
          throw new Error('Terminal service changed during preparation. Try again.');
      },
      activate: () => run('/bin/bash', [join(stage, 'scripts/install.sh')]),
      healthy: () => healthy(release.version),
      restore,
      oldHealthy: () => healthy(prior.version),
    });
  } catch (error) {
    const current = readJson(journalFile);
    if (recover) journal('manual', error.message);
    else if (!['rolled-back', 'manual'].includes(current?.phase)) journal('error', error.message);
    throw error;
  } finally {
    rmSync(lock, { recursive: true, force: true });
    await query(port, token, { t: 'finish-companion-update' }).catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runWorker(homedir(), process.argv.includes('--recover')).catch((error) => {
    const file = join(homedir(), '.local/state/tabterm/updates/status.json');
    const prior = readJson(file);
    if (!['rolled-back', 'manual'].includes(prior?.phase))
      writeJson(file, { phase: 'error', updatedAt: Date.now(), message: error.message });
    // A handled failure is recorded for the UI, not a reason for launchd to retry it.
  });
}
