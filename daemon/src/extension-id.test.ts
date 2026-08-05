import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkExtensionId, extensionIdForKey } from './extension-id.js';

/**
 * The ID this repository ships, read from the one place that records it.
 *
 * For an unpacked or self-distributed build it must equal what the manifest key derives, which
 * is what this file exists to assert. If the ID here is a Chrome Web Store one, the store minted
 * it from a key it holds and the derivation will not match; that case is detected rather than
 * failed, because it is a legitimate configuration and not a mistake.
 */
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  tabterm: { extensionId: string };
};
const EXPECTED = pkg.tabterm.extensionId;
const DERIVED_FROM_KEY = 'mcchodnlokiofihbecdeicicfhmgpadb';

const manifest = JSON.parse(
  readFileSync(new URL('../../extension/public/manifest.json', import.meta.url), 'utf8'),
) as { key?: string };

describe('extension id derivation', () => {
  it('derives the same id the manifest key has always produced', () => {
    // This is the test that would fail if anyone regenerated the key, which would silently
    // invalidate every stable session URL in every user's Chrome history.
    expect(extensionIdForKey(manifest.key ?? '')).toBe(DERIVED_FROM_KEY);
  });

  it('agrees with the id recorded in package.json, or says why not', () => {
    // A Web Store build legitimately differs: the store mints the ID from its own key. What
    // must never happen is the two drifting apart by accident.
    if (EXPECTED !== DERIVED_FROM_KEY) {
      expect(EXPECTED).toMatch(/^[a-p]{32}$/);
      return;
    }
    expect(extensionIdForKey(manifest.key ?? '')).toBe(EXPECTED);
  });

  it('produces an id of the right shape', () => {
    const id = extensionIdForKey(manifest.key ?? '');
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('is stable across calls', () => {
    expect(extensionIdForKey(manifest.key ?? '')).toBe(extensionIdForKey(manifest.key ?? ''));
  });

  it('gives a different id for a different key', () => {
    const other = Buffer.from('a different public key entirely').toString('base64');
    expect(extensionIdForKey(other)).not.toBe(EXPECTED);
  });
});

describe('checking a manifest', () => {
  it('accepts the shipped manifest', () => {
    const result = checkExtensionId(manifest, EXPECTED);
    expect(result.ok).toBe(true);
  });

  it('explains a missing key rather than just failing', () => {
    // Without a key the ID follows the install path, which is a different problem with a
    // different fix from a key that produces the wrong ID.
    const result = checkExtensionId({}, EXPECTED);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/no "key"/);
  });

  it('reports which id a wrong key would produce', () => {
    const other = Buffer.from('some other key').toString('base64');
    const result = checkExtensionId({ key: other }, EXPECTED);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('expected');
  });

  it('rejects a key that is not base64 at all', () => {
    const result = checkExtensionId({ key: '!!!not base64!!!' }, EXPECTED);
    expect(result.ok).toBe(false);
  });
});
