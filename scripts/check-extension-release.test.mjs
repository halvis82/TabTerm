import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { packageExtension } from './extension-archive.mjs';
import { checkExtensionRelease } from './check-extension-release.mjs';

it('rejects wrong tags, development keys and archive bytes from a different build', () => {
  const root = mkdtempSync(join(tmpdir(), 'tabterm-release-'));
  try {
    for (const dir of ['extension/public', 'extension/dist', 'shared/src', 'dist'])
      mkdirSync(join(root, dir), { recursive: true });
    const write = (path, value) =>
      writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
    const version = '1.0.3';
    const manifest = { version, key: 'public-key', name: 'TabTerm', manifest_version: 3 };
    write('package.json', {
      version,
      tabterm: { publishedExtensionId: 'llpnnikkigahedhoedecpgjcnmfcgfen' },
    });
    write('package-lock.json', { version, packages: { '': { version } } });
    write('shared/src/index.ts', `export const VERSION = '${version}';`);
    write('extension/public/manifest.json', manifest);
    write('extension/dist/manifest.json', manifest);
    write('extension/dist/terminal.js', 'original');
    write('extension/dist/terminal.js.map', 'source map');
    const zip = join(root, 'dist/tabterm-extension-1.0.3.zip');
    packageExtension(join(root, 'extension/dist'), zip);
    expect(checkExtensionRelease(root, 'v1.0.3').sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => checkExtensionRelease(root, 'v1.0.2')).toThrow('tag must match');
    write('extension/dist/terminal.js', 'different build');
    expect(() => checkExtensionRelease(root)).toThrow('archive differs');
    packageExtension(join(root, 'extension/dist'), zip, false);
    expect(() => checkExtensionRelease(root)).toThrow('store manifest must omit only key');
    packageExtension(join(root, 'extension/dist'), zip);
    write('package-lock.json', { version: '1.0.2', packages: { '': { version } } });
    expect(() => checkExtensionRelease(root)).toThrow('lockfile version');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
