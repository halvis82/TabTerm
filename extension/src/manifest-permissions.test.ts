import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every permission the extension asks for has a written reason, and every written reason is real.
 *
 * A permission is the most expensive thing an extension asks of somebody, and the store asks for a
 * justification for each. The failure this catches is one of drift in both directions: a permission
 * added and never explained, and an explanation left behind for a permission that was dropped.
 *
 * `clipboardWrite` and `alarms` were both requested and undocumented when this was written.
 */
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '..', 'public', 'manifest.json'), 'utf8')) as {
  permissions: string[];
  content_security_policy?: { extension_pages?: string };
};
const security = readFileSync(join(here, '..', '..', 'docs', '05-security.md'), 'utf8');

/**
 * The permissions table, and only that.
 *
 * Scoped to the one table rather than every table in the document, because the file has several
 * and a bare scan of them treated an environment variable in a different section as a Chrome
 * permission that nobody was requesting.
 */
const table = security.slice(
  security.indexOf('| Permission | Why |'),
  security.indexOf('No `<all_urls>`'),
);
const documented = new Set(
  [...table.matchAll(/^\| `([a-zA-Z]+)` \|/gm)].map((m) => m[1]).filter((x) => x !== undefined),
);

describe('what the extension asks Chrome for', () => {
  it('explains every permission it requests', () => {
    const undocumented = manifest.permissions.filter((p) => !documented.has(p));
    expect(undocumented, 'each of these needs a line in docs/05-security.md').toEqual([]);
  });

  it('asks for everything it explains', () => {
    // The other direction. A line describing a permission nobody requests is a reason to think the
    // extension does something it no longer does.
    const requested = new Set(manifest.permissions);
    const stale = [...documented].filter(
      (p) => !requested.has(p) && p !== 'commands' && p !== 'key',
    );
    expect(stale, 'these are documented and not requested').toEqual([]);
  });
});

/**
 * The pages may compile WebAssembly that ships inside the extension, which the picture decoder in
 * the terminal needs, and nothing more: no eval, nothing from outside the extension. Without it the
 * decoder failed partway through a picture and the terminal drew nothing after it.
 */
describe('what the extension pages may run', () => {
  it('is its own scripts and its own WebAssembly, and nothing else', () => {
    expect(manifest.content_security_policy?.extension_pages).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    );
  });

  it('is explained where the permissions are', () => {
    expect(security).toContain("'wasm-unsafe-eval'");
  });
});
