import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { download } from './network.mjs';
import { activateUpdate, readJson } from './state.mjs';
import { UpdateManager } from './manager.mjs';
import { extractSource } from './archive.mjs';
import { packageCompanion } from '../package-companion.mjs';

const roots = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), 'tabterm-updater-'));
  roots.push(h);
  return h;
};
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const manifest = {
  schema: 1,
  version: '1.1.0',
  tag: 'v1.1.0',
  commit: 'a'.repeat(40),
  source: {
    url: 'https://github.com/halvis82/TabTerm/releases/download/v1.1.0/tabterm-companion-1.1.0.tar.gz',
    sha256: 'b'.repeat(64),
    bytes: 100,
  },
  compatibility: { protocol: 1, host: 1, storage: 1, nodeMajor: 22, macosMajor: 13 },
};
function manager(options = {}) {
  const root = home();
  const path = join(root, '.local/libexec/tabterm');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'update-worker.mjs'), '');
  writeFileSync(join(path, 'installation.json'), '{}');
  const fetchBytes = vi.fn(async (url) =>
    Buffer.from(
      JSON.stringify(
        url.endsWith('/latest')
          ? {
              tag_name: 'v1.1.0',
              assets: [
                {
                  name: 'companion-release.json',
                  browser_download_url:
                    'https://github.com/halvis82/TabTerm/releases/download/v1.1.0/companion-release.json',
                },
              ],
            }
          : manifest,
      ),
    ),
  );
  const launch = vi.fn(async () => {});
  const m = new UpdateManager({ home: root, version: '1.0.2', fetchBytes, launch, ...options });
  return { m, root, fetchBytes, launch };
}
describe('update checks and preferences', () => {
  it('does no network work by default', async () => {
    const { m, fetchBytes } = manager();
    await m.tick();
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(m.snapshot().automaticInstall).toBe(false);
  });
  it('checks without installing, deduplicates and rate limits', async () => {
    const { m, fetchBytes, launch } = manager();
    await Promise.all([m.check(), m.check()]);
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(m.snapshot().canInstall).toBe(true);
    await m.check();
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
  });
  it('persists opt-in preferences and implies checks for auto installs', async () => {
    const { m, root } = manager();
    m.preferencesChanged(false, true);
    await m.checking;
    const next = new UpdateManager({ home: root, version: '1.0.2' });
    expect(next.snapshot().automaticChecks).toBe(true);
    expect(next.snapshot().automaticInstall).toBe(true);
    m.preferencesChanged(false, false);
    await m.tick();
    expect(
      readJson(join(root, '.local/state/tabterm/updates/preferences.json')).automaticChecks,
    ).toBe(false);
  });
  it('requires a check before install and prevents double installs', async () => {
    const { m, launch } = manager();
    await m.install();
    expect(launch).not.toHaveBeenCalled();
    await m.check();
    await Promise.all([m.install(), m.install()]);
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it('does not install an older or equal release', async () => {
    const { m } = manager({ version: '1.1.0' });
    await m.check();
    expect(m.snapshot().phase).toBe('current');
    expect(m.snapshot().canInstall).toBe(false);
  });
  it('does not enable installation in a development checkout', async () => {
    const { m } = manager({ enabled: false });
    await m.check();
    expect(m.snapshot().canInstall).toBe(false);
  });
  it('reports missing release assets without inventing an update', async () => {
    const { m } = manager({
      fetchBytes: async () => Buffer.from('{"tag_name":"v1.1.0","assets":[]}'),
    });
    await m.check();
    expect(m.snapshot().phase).toBe('error');
    expect(m.snapshot().message).toContain('No companion');
  });
  it('does not install if opt-in is withdrawn while checking', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const { m, fetchBytes, launch } = manager();
    const original = m.fetchBytes;
    m.fetchBytes = async (...args) => {
      await gate;
      return original(...args);
    };
    m.preferencesChanged(true, true);
    m.preferencesChanged(false, false);
    release();
    await m.checking;
    expect(fetchBytes).toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});
describe('bounded update downloads', () => {
  it('rejects non-HTTPS and redirects outside GitHub', async () => {
    const f = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
    );
    await expect(download('https://github.com/x', 100, f)).rejects.toThrow('Untrusted');
    expect(f).toHaveBeenCalledTimes(1);
    await expect(download('http://github.com/x', 100, f)).rejects.toThrow('Untrusted');
  });
  it('rejects oversized streamed data even without content length', async () => {
    await expect(
      download('https://github.com/x', 3, async () => new Response('1234')),
    ).rejects.toThrow();
  });
  it('returns bounded data and explains unpublished releases', async () => {
    expect(
      (await download('https://github.com/x', 20, async () => new Response('yes'))).toString(),
    ).toBe('yes');
    await expect(
      download('https://github.com/x', 20, async () => new Response(null, { status: 404 })),
    ).rejects.toThrow('No companion release');
  });
});
describe('activation and recovery', () => {
  function adapters() {
    const events = [];
    const step = (name) => async () => {
      events.push(name);
    };
    return {
      events,
      a: {
        journal: async (p) => events.push(p),
        prepare: step('build'),
        backup: step('backup'),
        activate: step('replace'),
        healthy: async () => true,
        restore: step('restore'),
        oldHealthy: async () => true,
      },
    };
  }
  it('journals before mutation and declares success only after health', async () => {
    const { events, a } = adapters();
    await activateUpdate(a);
    expect(events).toEqual(['preparing', 'build', 'backup', 'installing', 'replace', 'updated']);
  });
  it('leaves current installation untouched on build failure', async () => {
    const { events, a } = adapters();
    a.prepare = async () => {
      throw Error('build');
    };
    await expect(activateUpdate(a)).rejects.toThrow('build');
    expect(events).toEqual(['preparing']);
  });
  it('restores previous files after failed new-daemon health', async () => {
    const { events, a } = adapters();
    a.healthy = async () => false;
    await expect(activateUpdate(a)).rejects.toThrow('health');
    expect(events.slice(-2)).toEqual(['restore', 'rolled-back']);
  });
  it('reports failed recovery rather than pretending success', async () => {
    const { events, a } = adapters();
    a.activate = async () => {
      throw Error('activation');
    };
    a.oldHealthy = async () => false;
    await expect(activateUpdate(a)).rejects.toThrow('Automatic recovery failed');
    expect(events.at(-1)).toBe('manual');
  });
});
describe('source releases', () => {
  it('packages committed files deterministically and extracts their exact contents', () => {
    const root = home();
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'package.json'), '{"version":"1.1.0"}');
    writeFileSync(join(root, 'file.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
      { cwd: root },
    );
    const a = packageCompanion(root);
    const b = packageCompanion(root);
    expect(a.source.sha256).toBe(b.source.sha256);
    const extracted = join(root, 'extracted');
    extractSource(readFileSync(join(root, 'dist/tabterm-companion-1.1.0.tar.gz')), extracted);
    expect(readFileSync(join(extracted, 'file.txt'), 'utf8')).toBe('hello');
  });
  it.each(['tabterm/../escape', '/tmp/escape', 'tabterm/link'])(
    'rejects unsafe tar member %s',
    (name) => {
      const h = Buffer.alloc(512);
      h.write(name);
      h.write('00000000000', 124);
      h.write(name.endsWith('link') ? '2' : '0', 156);
      h.fill(32, 148, 156);
      h.write(
        h
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, '0') + '\0 ',
        148,
      );
      expect(() =>
        extractSource(gzipSync(Buffer.concat([h, Buffer.alloc(1024)])), home()),
      ).toThrow();
    },
  );
});
