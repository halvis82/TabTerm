import { createHash } from 'node:crypto';

/**
 * The extension ID Chrome will assign to a given public key.
 *
 * Every stable session URL in a user's Chrome history is a `chrome-extension://<id>/...` URL, so
 * the ID changing silently invalidates all of them. The `key` field in the manifest pins it, and
 * this is how to check that the pin still produces the ID that was minted, rather than
 * discovering otherwise after shipping an update.
 *
 * Chrome's derivation: SHA-256 of the DER-encoded public key, first 16 bytes, each nibble
 * rendered in a 26-letter alphabet where 0 maps to 'a'. See docs/13-packaging.md §3.
 */
export function extensionIdForKey(base64Key: string): string {
  const der = Buffer.from(base64Key, 'base64');
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/**
 * Whether a manifest still produces the ID it is supposed to.
 *
 * Returns a reason rather than a bare false, because "the key is missing" and "the key produces
 * a different ID" call for completely different responses.
 */
export function checkExtensionId(
  manifest: { key?: unknown },
  expected: string,
): { ok: true; id: string } | { ok: false; reason: string } {
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
    return { ok: false, reason: 'manifest has no "key", so the ID depends on the install path' };
  }
  let id: string;
  try {
    id = extensionIdForKey(manifest.key);
  } catch {
    return { ok: false, reason: 'manifest "key" is not valid base64' };
  }
  if (id !== expected) {
    return { ok: false, reason: `key produces ${id}, expected ${expected}` };
  }
  return { ok: true, id };
}
