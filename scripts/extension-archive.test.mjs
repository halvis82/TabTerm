import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { packageExtension } from './extension-archive.mjs';

it('removes only the store key, preserves local identity and replaces stale ZIP entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'tabterm-package-test-'));
  try {
    const source = join(root, 'source');
    mkdirSync(source);
    const manifest = { manifest_version: 3, version: '1.0.2', key: 'public-key', name: 'test' };
    const original = JSON.stringify(manifest);
    writeFileSync(join(source, 'manifest.json'), original);
    writeFileSync(join(source, 'terminal.js'), 'console.log("test");');
    writeFileSync(join(source, 'terminal.js.map'), 'private source map');
    const archive = join(root, 'extension.zip');
    const member = (name) =>
      execFileSync('/usr/bin/unzip', ['-p', archive, name], { encoding: 'utf8' });
    packageExtension(source, archive, false);
    expect(member('manifest.json')).toBe(original);
    writeFileSync(join(source, 'obsolete.txt'), 'old');
    packageExtension(source, archive);
    rmSync(join(source, 'obsolete.txt'));
    packageExtension(source, archive);
    expect(JSON.parse(member('manifest.json'))).toEqual({
      manifest_version: 3,
      version: '1.0.2',
      name: 'test',
    });
    expect(member('terminal.js')).toBe(readFileSync(join(source, 'terminal.js'), 'utf8'));
    expect(readFileSync(join(source, 'manifest.json'), 'utf8')).toBe(original);
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8' });
    expect(entries).not.toContain('.map');
    expect(entries).not.toContain('obsolete.txt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
