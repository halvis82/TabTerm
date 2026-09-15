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

/**
 * And the version a shell is handed, which was missed by every bump.
 *
 * `TABTERM_VERSION` is put into the environment of every terminal TabTerm starts, and it said
 * `0.0.0` months after the release was 0.1.0: the bump changed the places somebody thought to
 * look, and this was not one of them. A shell whose environment reports the wrong version lies to
 * whatever reads it, and nothing was comparing the two.
 *
 * Read out of the source rather than by spawning a shell, because spawning one here would make a
 * check about a string into a check about node-pty.
 */
describe('the version a spawned terminal is told', () => {
  const ptyManager = readFileSync(join(root, 'daemon/src/pty-manager.ts'), 'utf8');

  it('comes from the shared constant rather than a number typed in', () => {
    expect(ptyManager).toContain('TABTERM_VERSION: VERSION');
  });

  it('is not a hardcoded version at all', () => {
    // Any literal here is a fourth place to remember, which is three more than works.
    expect(ptyManager).not.toMatch(/TABTERM_VERSION:\s*['"]/);
  });

  it('and that constant is the released one', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
