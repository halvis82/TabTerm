import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { updaterPlist } from './launchd.mjs';
import {
  RELEASE_API,
  parseCompanionRelease,
  compatibilityIssue,
  compareVersions,
} from '../../shared/src/updates.ts';
import { download } from './network.mjs';
import { readJson, writeJson } from './state.mjs';
const exec = promisify(execFile);
const busy = new Set(['preparing', 'installing']);
export class UpdateManager {
  constructor({
    home,
    version,
    enabled = true,
    port = 7377,
    changed = () => {},
    fetchBytes = download,
    launch,
    clock = Date.now,
  }) {
    Object.assign(this, { home, version, enabled, port, changed, fetchBytes, clock });
    this.directory = join(home, '.local/state/tabterm/updates');
    this.installed = join(home, '.local/libexec/tabterm');
    this.preferences = readJson(join(this.directory, 'preferences.json'), {});
    this.status = {
      installedVersion: version,
      phase: 'idle',
      message: 'Check for a released companion update.',
      automaticChecks: this.preferences.automaticChecks === true,
      automaticInstall:
        this.preferences.automaticChecks === true && this.preferences.automaticInstall === true,
      canInstall: false,
      ...(Number.isFinite(this.preferences.checkedAt)
        ? { checkedAt: this.preferences.checkedAt }
        : {}),
    };
    this.launch = launch ?? (() => this.launchWorker());
    this.lastAttempt = this.preferences.lastAttempt ?? 0;
    this.release = null;
    this.checking = null;
    this.refresh();
  }
  snapshot() {
    return { ...this.status };
  }
  emit(patch) {
    Object.assign(this.status, patch);
    this.changed(this.snapshot());
  }
  start() {
    this.timer = setInterval(() => {
      this.refresh();
      void this.tick();
    }, 2000);
    this.timer.unref?.();
    const job = readJson(join(this.directory, 'status.json'));
    if (
      this.enabled &&
      this.status.phase === 'manual' &&
      job?.phase === 'installing' &&
      existsSync(join(this.directory, 'transaction.json'))
    ) {
      void this.launchWorker(true).catch(() => {});
    }
    void this.tick();
  }
  stop() {
    clearInterval(this.timer);
    this.stopped = true;
  }
  preferencesChanged(checks, install) {
    if (typeof checks !== 'boolean' || typeof install !== 'boolean') return;
    this.preferences = {
      ...this.preferences,
      automaticChecks: checks || install,
      automaticInstall: install,
    };
    writeJson(join(this.directory, 'preferences.json'), this.preferences);
    this.emit({
      automaticChecks: this.preferences.automaticChecks,
      automaticInstall: this.preferences.automaticInstall,
    });
    void this.tick();
  }
  async tick() {
    if (this.stopped || !this.status.automaticChecks || busy.has(this.status.phase)) return;
    if (this.clock() - this.lastAttempt >= 24 * 60 * 60 * 1000) await this.check();
  }
  refresh() {
    const job = readJson(join(this.directory, 'status.json'));
    if (!job || (job.updatedAt === this.lastJobAt && !busy.has(job.phase))) return;
    this.lastJobAt = job.updatedAt;
    if (
      !['preparing', 'installing', 'updated', 'rolled-back', 'manual', 'error'].includes(job.phase)
    )
      return;
    let phase = job.phase;
    if (busy.has(phase) && !job.pid && this.clock() - job.updatedAt > 30_000) phase = 'error';
    if (busy.has(phase) && job.pid) {
      try {
        process.kill(job.pid, 0);
      } catch {
        phase = 'manual';
      }
    }
    const messages = {
      preparing: 'Downloading and building the companion. Your terminals can stay open.',
      installing: 'Installing the companion. Terminal views will reconnect.',
      updated: 'Companion update completed.',
      'rolled-back': 'The update failed. The previous companion was restored.',
      manual:
        'An interrupted update needs recovery. Run the companion installer from a known-good checkout.',
      error:
        job.message || 'The update failed before completion. Try again or use the setup guide.',
    };
    if (this.status.phase !== phase || this.status.message !== messages[phase])
      this.emit({ phase, message: messages[phase], canInstall: false });
  }
  async check() {
    if (this.checking) return this.checking;
    if (busy.has(this.status.phase)) return;
    if (this.clock() - this.lastAttempt < 60_000) {
      this.emit({ message: 'Please wait a minute before checking again.' });
      return;
    }
    this.lastAttempt = this.clock();
    this.preferences.lastAttempt = this.lastAttempt;
    writeJson(join(this.directory, 'preferences.json'), this.preferences);
    this.emit({
      phase: 'checking',
      message: 'Checking GitHub for a companion release.',
      canInstall: false,
    });
    this.checking = (async () => {
      try {
        const listing = JSON.parse((await this.fetchBytes(RELEASE_API, 256 * 1024)).toString());
        if (listing.draft || listing.prerelease || !/^v\d+\.\d+\.\d+$/.test(listing.tag_name ?? ''))
          throw new Error('No stable companion release is published yet.');
        const asset = listing.assets?.find((a) => a.name === 'companion-release.json');
        const url = `https://github.com/halvis82/TabTerm/releases/download/${listing.tag_name}/companion-release.json`;
        if (!asset || asset.browser_download_url !== url)
          throw new Error('No companion update package is published for this release yet.');
        const release = parseCompanionRelease(
          JSON.parse((await this.fetchBytes(url, 32 * 1024)).toString()),
        );
        if (release.tag !== listing.tag_name)
          throw new Error('Release metadata does not match its tag');
        this.release = release;
        this.preferences.checkedAt = this.clock();
        writeJson(join(this.directory, 'preferences.json'), this.preferences);
        const newer = compareVersions(release.version, this.version) > 0;
        const issue = compatibilityIssue(release);
        const canInstall =
          newer &&
          !issue &&
          this.enabled &&
          existsSync(join(this.installed, 'update-worker.mjs')) &&
          existsSync(join(this.installed, 'installation.json'));
        this.emit({
          phase: newer ? (issue ? 'manual' : 'available') : 'current',
          availableVersion: release.version,
          checkedAt: this.clock(),
          canInstall,
          message: !newer
            ? 'Your companion is up to date.'
            : (issue ??
              (canInstall
                ? 'A companion update is available.'
                : 'Install the current companion once using the setup guide to enable updates.')),
        });
        if (
          canInstall &&
          this.status.automaticInstall &&
          !this.stopped &&
          this.preferences.lastAutoVersion !== release.version
        ) {
          this.preferences.lastAutoVersion = release.version;
          writeJson(join(this.directory, 'preferences.json'), this.preferences);
          await this.install();
        }
      } catch (error) {
        this.emit({ phase: 'error', message: error.message, canInstall: false });
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }
  async install() {
    if (!this.status.canInstall || !this.release || busy.has(this.status.phase)) return;
    this.emit({ phase: 'preparing', canInstall: false, message: 'Starting companion update.' });
    try {
      writeJson(join(this.directory, 'request.json'), { release: this.release, port: this.port });
      await this.launch();
    } catch {
      this.emit({
        phase: 'error',
        message: 'The updater could not start. Run the companion installer once and try again.',
        canInstall: false,
      });
    }
  }
  async launchWorker(recover = false) {
    const installation = recover
      ? readJson(join(this.directory, 'transaction.json'))?.prior
      : readJson(join(this.installed, 'installation.json'));
    if (!installation?.node || process.platform !== 'darwin')
      throw new Error('Companion updater is not installed');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'worker.lock');
    if (existsSync(lock)) {
      const owner = readJson(join(lock, 'owner.json'));
      if (owner?.pid) {
        let alive = true;
        try {
          process.kill(owner.pid, 0);
        } catch {
          alive = false;
        }
        if (alive) throw new Error('Another updater is running');
      }
      if (!recover && readJson(join(this.directory, 'status.json'))?.phase === 'installing')
        throw new Error('An earlier update needs recovery');
      rmSync(lock, { recursive: true, force: true });
    }
    if (!recover)
      cpSync(join(this.installed, 'update-worker.mjs'), join(this.directory, 'worker.mjs'));
    const plist = join(this.directory, 'updater.plist');
    writeFileSync(
      plist,
      updaterPlist(installation.node, join(this.directory, 'worker.mjs'), this.home, recover),
      { mode: 0o600 },
    );
    await exec('/bin/launchctl', ['bootout', `gui/${process.getuid()}/com.tabterm.updater`]).catch(
      () => {},
    );
    for (let i = 0; i < 20; i++) {
      try {
        await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/com.tabterm.updater`]);
        await wait(250);
      } catch {
        break;
      }
    }
    if (!recover)
      writeJson(join(this.directory, 'status.json'), {
        phase: 'preparing',
        updatedAt: this.clock(),
        pid: 0,
      });
    await exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
  }
}
