import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkExtensionId, extensionIdForKey } from './extension-id.js';

/** The ID that was minted once and can never change. See docs/13-packaging.md §3. */
const EXPECTED = 'mcchodnlokiofihbecdeicicfhmgpadb';

const manifest = JSON.parse(
  readFileSync(new URL('../../extension/public/manifest.json', import.meta.url), 'utf8'),
) as { key?: string };

describe('extension id derivation', () => {
  it('derives the shipped id from the shipped key', () => {
    // This is the test that would fail if anyone regenerated the key, which would silently
    // invalidate every stable session URL in every user's Chrome history.
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
