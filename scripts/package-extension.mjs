#!/usr/bin/env node
// Package the extension for distribution, and refuse to do it if the ID would change.
//
// The extension ID is permanent. Every stable session URL in a user's Chrome history is
// `chrome-extension://<id>/terminal.html?workspace=...`, so an update that changes the ID
// silently invalidates all of them. The `key` in the manifest pins it; this checks the pin
// still produces the ID that was minted rather than finding out after shipping.
//
//   node scripts/package-extension.mjs           -> dist/tabterm-extension-<version>.zip
//   node scripts/package-extension.mjs --policy  -> also write the managed-policy plist
//
// See docs/13-packaging.md §3.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExtensionId } from '../daemon/dist/extension-id.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'extension', 'dist');
const OUT = join(ROOT, 'dist');
/**
 * The ID this build is expected to have.
 *
 * For an unpacked or self-distributed build it is derived from the manifest key, and this check
 * is what stops a regenerated key from silently invalidating every stable URL. A Chrome Web
 * Store build is different: the store assigns the ID and the key cannot control it, so
 * `--published` skips the check and the store's ID goes in package.json instead.
 */
const EXPECTED_ID = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).tabterm
  .extensionId;
const forStore = process.argv.includes('--published');

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('extension/dist is not built. Run `npm run build:extension` first.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));

// The check that matters. Everything else in this script is a zip.
if (forStore) {
  // The store mints its own ID from a key it holds. Checking against the manifest key here
  // would fail for a reason that is not a problem.
  console.log('  packaging for the Web Store: the store assigns the id, so it is not checked');
  console.log('  after publishing, put the assigned id in package.json and re-run install.sh');
} else {
  const check = checkExtensionId(manifest, EXPECTED_ID);
  if (!check.ok) {
    console.error(`Refusing to package: ${check.reason}`);
    console.error('Shipping this would invalidate every stable session URL in Chrome history.');
    process.exit(1);
  }
  console.log(`  extension id: ${check.id} (matches the id in package.json)`);
}

mkdirSync(OUT, { recursive: true });
const zip = join(OUT, `tabterm-extension-${String(manifest.version)}.zip`);
execFileSync('/usr/bin/zip', ['-qr', zip, '.', '-x', '*.map'], { cwd: DIST });
console.log(`  package: ${zip}`);

if (process.argv.includes('--policy')) {
  /**
   * Managed-policy force-install.
   *
   * The alternative to a Web Store listing, and the one that needs no review. An extension that
   * connects to loopback and runs shell commands is a nontrivial review, so this exists as the
   * fully local route.
   *
   * The plist is written, not installed. Installing it needs root and changes how Chrome
   * behaves for every profile on the machine, which is not a thing a build script should do
   * without being asked.
   */
  const plist = join(OUT, 'com.google.Chrome.TabTerm.plist');
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ExtensionSettings</key>
  <dict>
    <key>${EXPECTED_ID}</key>
    <dict>
      <!-- force_installed also means Chrome cannot nag about it or let it be disabled. -->
      <key>installation_mode</key><string>force_installed</string>
      <key>update_url</key><string>https://clients2.google.com/service/update2/crx</string>
      <key>toolbar_pin</key><string>force_pinned</string>
    </dict>
  </dict>
</dict>
</plist>
`,
  );
  console.log(`  policy:  ${plist}`);
  console.log('');
  console.log('  Not installed. To apply it for every profile on this machine:');
  console.log(`    sudo cp ${plist} /Library/Managed\\ Preferences/com.google.Chrome.plist`);
  console.log('    sudo killall cfprefsd && restart Chrome');
  console.log('');
  console.log('  The update_url above is the Web Store. Point it at your own update manifest');
  console.log('  to distribute without a listing.');
}
