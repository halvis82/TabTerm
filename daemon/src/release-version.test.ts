import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@tabterm/shared';

/**
 * The number this product calls itself, in the two places it is published.
 *
 * The extension's manifest carries one and the daemon reports another, and they are one product. A
 * person reporting a problem should not have to say which of two versions they mean, and a store
 * listing showing something different from what the daemon says is a question nobody can answer.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'extension/public/manifest.json'), 'utf8')) as {
  version: string;
  manifest_version: number;
  permissions: string[];
};
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

describe('the release version', () => {
  it('is not all zeroes, which is not a release', () => {
    // Chrome accepts 0.0.0 and it means "nobody has decided yet", which is not a thing to publish.
    expect(manifest.version).not.toBe('0.0.0');
    expect(pkg.version).not.toBe('0.0.0');
  });

  it('is the same number in the manifest, the package and the daemon', () => {
    expect(pkg.version).toBe(manifest.version);
    expect(VERSION).toBe(manifest.version);
  });

  it('is a version Chrome will accept: up to four numbers, nothing else', () => {
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
  });

  it('is still manifest v3', () => {
    expect(manifest.manifest_version).toBe(3);
  });
});
