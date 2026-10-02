import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { runWorker } from './worker.mjs';
import { readJson, writeJson } from './state.mjs';
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'tabterm-worker-'));
  roots.push(home);
  const installed = join(home, '.local/libexec/tabterm'),
    updates = join(home, '.local/state/tabterm/updates'),
    source = join(home, 'fixture-source');
  const write = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };
  const database = 'unchanged migration definitions';
  write(join(source, 'package.json'), '{"version":"1.1.0"}');
  write(join(source, 'daemon/src/database.ts'), database);
  write(join(source, 'scripts/install.sh'), '# TABTERM_COMPANION_UPDATE\n');
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
    { cwd: source },
  );
  const archive = gzipSync(
    execFileSync('git', ['archive', '--format=tar', '--prefix=tabterm/', 'HEAD'], { cwd: source }),
  );
  const release = {
    schema: 1,
    version: '1.1.0',
    tag: 'v1.1.0',
    commit: 'a'.repeat(40),
    source: {
      url: 'https://github.com/halvis82/TabTerm/releases/download/v1.1.0/tabterm-companion-1.1.0.tar.gz',
      sha256: createHash('sha256').update(archive).digest('hex'),
      bytes: archive.length,
    },
    compatibility: { protocol: 1, host: 1, storage: 1, nodeMajor: 22, macosMajor: 13 },
  };
  writeJson(join(updates, 'request.json'), { release });
  const prior = {
    version: '1.0.2',
    node: process.execPath,
    databaseSha256: createHash('sha256').update(database).digest('hex'),
  };
  writeJson(join(installed, 'installation.json'), prior);
  writeJson(join(installed, 'node_modules/node-pty/package.json'), { version: '1.2.0' });
  write(join(installed, 'daemon.mjs'), 'old code');
  write(join(home, '.local/state/tabterm/token'), 'test-token');
  write(join(home, '.local/state/tabterm/tabterm.sqlite'), 'user data must survive');
  write(join(home, 'Library/LaunchAgents/com.tabterm.daemon.plist'), 'old plist');
  const options = { failInstall: false, failHealth: false };
  const run = vi.fn(async (command, args) => {
    if (args[0] === 'print') throw Error('service stopped');
    if (args[0] === 'ci')
      writeJson(join(updates, 'staging/node_modules/node-pty/package.json'), { version: '1.2.0' });
    if (command === '/bin/bash') {
      write(join(installed, 'daemon.mjs'), 'new code');
      writeJson(join(installed, 'installation.json'), { ...prior, version: '1.1.0' });
      if (options.failInstall) throw Error('install failure');
    }
  });
  const queryDaemon = vi.fn(async () => ({
    version: options.failHealth ? 'bad' : readJson(join(installed, 'installation.json')).version,
    durable: true,
    hostInstance: 'stable-host',
    sessionCount: 3,
  }));
  const adapters = { run, queryDaemon, download: vi.fn(async () => archive) };
  return { home, installed, updates, options, adapters };
}
it('builds only verified source, installs it, and retains terminal identity and user data', async () => {
  const f = fixture();
  await runWorker(f.home, false, f.adapters);
  expect(readFileSync(join(f.installed, 'daemon.mjs'), 'utf8')).toBe('new code');
  expect(readJson(join(f.updates, 'status.json')).phase).toBe('updated');
  expect(readFileSync(join(f.home, '.local/state/tabterm/tabterm.sqlite'), 'utf8')).toBe(
    'user data must survive',
  );
  expect(readFileSync(join(f.home, '.local/state/tabterm/token'), 'utf8')).toBe('test-token');
  expect(
    f.adapters.queryDaemon.mock.calls.some((args) => args[2]?.t === 'prepare-companion-update'),
  ).toBe(true);
  expect(existsSync(join(f.updates, 'worker.lock'))).toBe(false);
});
it('executes nothing when the download checksum is wrong', async () => {
  const f = fixture();
  const bytes = await f.adapters.download();
  f.adapters.download = async () => Buffer.alloc(bytes.length, 0);
  await expect(runWorker(f.home, false, f.adapters)).rejects.toThrow('verification');
  expect(f.adapters.run).not.toHaveBeenCalled();
  expect(readFileSync(join(f.installed, 'daemon.mjs'), 'utf8')).toBe('old code');
});
it('restores actual program files after a partially failed installer', async () => {
  const f = fixture();
  f.options.failInstall = true;
  await expect(runWorker(f.home, false, f.adapters)).rejects.toThrow('install failure');
  expect(readFileSync(join(f.installed, 'daemon.mjs'), 'utf8')).toBe('old code');
  expect(readJson(join(f.updates, 'status.json')).phase).toBe('rolled-back');
  expect(
    f.adapters.run.mock.calls.some(([, args]) => args.some((a) => String(a).includes('pty-host'))),
  ).toBe(false);
});
it('recovers an interrupted activation from the saved executable backup', async () => {
  const f = fixture();
  await runWorker(f.home, false, f.adapters);
  writeJson(join(f.updates, 'status.json'), { phase: 'installing', pid: 999999999, updatedAt: 1 });
  await runWorker(f.home, true, f.adapters);
  expect(readFileSync(join(f.installed, 'daemon.mjs'), 'utf8')).toBe('old code');
  expect(readJson(join(f.updates, 'status.json')).phase).toBe('rolled-back');
});
it('refuses a second worker without removing its lock', async () => {
  const f = fixture();
  writeJson(join(f.updates, 'worker.lock/owner.json'), { pid: process.pid });
  await expect(runWorker(f.home, false, f.adapters)).rejects.toThrow('Another updater');
  expect(existsSync(join(f.updates, 'worker.lock'))).toBe(true);
  expect(f.adapters.run).not.toHaveBeenCalled();
});
it('uses the authenticated daemon request port for preflight and recovery', async () => {
  const f = fixture();
  writeJson(join(f.updates, 'request.json'), {
    ...readJson(join(f.updates, 'request.json')),
    port: 8123,
  });
  await runWorker(f.home, false, f.adapters);
  expect(f.adapters.queryDaemon.mock.calls.every(([port]) => port === 8123)).toBe(true);
});
it('marks an interrupted activation as manual when executable recovery fails', async () => {
  const f = fixture();
  await runWorker(f.home, false, f.adapters);
  writeJson(join(f.updates, 'status.json'), { phase: 'installing', pid: 999999999, updatedAt: 1 });
  const original = f.adapters.run;
  f.adapters.run = async (command, args, cwd) => {
    if (args[0] === 'bootstrap') throw Error('service recovery failed');
    return original(command, args, cwd);
  };
  await expect(runWorker(f.home, true, f.adapters)).rejects.toThrow('service recovery failed');
  expect(readJson(join(f.updates, 'status.json')).phase).toBe('manual');
});

it('compiles workspace dependencies before bundling a clean source download', async () => {
  const f = fixture();
  const original = f.adapters.run;
  let compiled = false;
  f.adapters.run = async (command, args, cwd) => {
    if (args[0] === 'run' && args[1] === 'typecheck') compiled = true;
    if (args[0] === 'run' && args[1] === 'build' && !compiled)
      throw Error('Shared workspace package is not compiled');
    return original(command, args, cwd);
  };
  await runWorker(f.home, false, f.adapters);
  expect(readJson(join(f.updates, 'status.json')).phase).toBe('updated');
});
