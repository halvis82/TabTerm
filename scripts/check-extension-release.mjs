import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compare the release archive with the build, allowing only the public-key removal. */
export function checkExtensionRelease(root = '.', tag = '') {
  const json = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const pkg = json('package.json');
  const version = pkg.version;
  const lock = json('package-lock.json');
  assert.equal(lock.version, version, 'lockfile version');
  assert.equal(lock.packages[''].version, version, 'lockfile root version');
  assert.equal(json('extension/public/manifest.json').version, version, 'source manifest version');
  const shared = readFileSync(join(root, 'shared/src/index.ts'), 'utf8');
  assert.equal(shared.match(/export const VERSION = '([^']+)'/)?.[1], version, 'shared version');
  assert.match(pkg.tabterm.publishedExtensionId, /^[a-p]{32}$/, 'store ID must be configured');
  if (tag) assert.equal(tag, `v${version}`, 'tag must match packaged version');
  const archive = join(root, 'dist', `tabterm-extension-${version}.zip`);
  const unzip = (...args) => execFileSync('/usr/bin/unzip', args, { maxBuffer: 32 * 1024 * 1024 });
  unzip('-t', archive);
  const entries = unzip('-Z1', archive).toString().trim().split('\n');
  assert.equal(new Set(entries).size, entries.length, 'duplicate ZIP members');
  assert(entries.every((name) => !name.startsWith('/') && !name.split('/').includes('..')));
  const files = entries.filter((name) => !name.endsWith('/')).sort();
  const built = join(root, 'extension/dist');
  const expected = readdirSync(built, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.map'))
    .map((entry) => join(entry.parentPath, entry.name).slice(built.length + 1))
    .sort();
  assert.deepEqual(files, expected, 'archive contains exactly the built files without maps');
  for (const name of files) {
    const actual = unzip('-p', archive, name);
    const original = readFileSync(join(built, name));
    if (name === 'manifest.json') {
      const manifest = JSON.parse(original);
      assert.equal(manifest.version, version);
      assert(manifest.key, 'unpacked manifest must retain its identity key');
      delete manifest.key;
      assert.deepEqual(JSON.parse(actual), manifest, 'store manifest must omit only key');
    } else {
      assert(actual.equals(original), `archive differs from build: ${name}`);
    }
  }
  return {
    version,
    archive,
    sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkExtensionRelease('.', process.argv[2]), null, 2));
}
