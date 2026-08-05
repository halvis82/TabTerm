#!/usr/bin/env node
// Build TabTerm.app: the daemon inside a bundle with a stable identifier.
//
// This is not packaging polish. macOS attaches TCC grants to a bundle identifier, and a bare
// `node` process has none, so every privacy prompt would read "node wants access to your
// Desktop" and the grant would be tied to a binary path that a Homebrew upgrade moves. Inside a
// bundle the grant attaches to `com.tabterm.daemon` and survives. See docs/13-packaging.md §1
// and docs/10-limitations.md tier 2.1.
//
//   node scripts/build-app-bundle.mjs [--sign <identity>]
//
// With no identity, the bundle is signed ad-hoc. That is enough for TCC to have something
// stable to attach to on this machine, and not enough to distribute. The script says which one
// it did rather than leaving it ambiguous.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'dist', 'TabTerm.app');
const CONTENTS = join(APP, 'Contents');
const BUNDLE_ID = 'com.tabterm.daemon';

const args = process.argv.slice(2);
const signIndex = args.indexOf('--sign');
const identity = signIndex >= 0 ? args[signIndex + 1] : null;

if (!existsSync(join(ROOT, 'daemon', 'dist', 'main.js'))) {
  console.error('daemon/dist/main.js is missing. Run `npm run build:daemon` first.');
  process.exit(1);
}

rmSync(APP, { recursive: true, force: true });
mkdirSync(join(CONTENTS, 'MacOS'), { recursive: true });
mkdirSync(join(CONTENTS, 'Resources'), { recursive: true });

const version = JSON.parse(
  execFileSync('/bin/cat', [join(ROOT, 'package.json')], { encoding: 'utf8' }),
).version;

writeFileSync(
  join(CONTENTS, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>TabTerm</string>
  <key>CFBundleExecutable</key><string>tabtermd</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- A background daemon. Nothing here should ever appear in the Dock. -->
  <key>LSBackgroundOnly</key><true/>
  <!-- Shown in the privacy prompt instead of "node". This string is the whole point. -->
  <key>NSDesktopFolderUsageDescription</key>
  <string>TabTerm runs terminal sessions, which can read files you open in them.</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>TabTerm runs terminal sessions, which can read files you open in them.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>TabTerm runs terminal sessions, which can read files you open in them.</string>
</dict>
</plist>
`,
);

cpSync(join(ROOT, 'daemon', 'dist'), join(CONTENTS, 'Resources', 'daemon'), { recursive: true });

// node_modules travels with the bundle: node-pty is native and cannot be bundled, and its
// spawn-helper must keep its executable bit or every PTY spawn fails with a bare
// "posix_spawnp failed". That bug cost real time once already.
const modules = join(ROOT, 'node_modules', 'node-pty');
if (existsSync(modules)) {
  cpSync(modules, join(CONTENTS, 'Resources', 'node_modules', 'node-pty'), { recursive: true });
  const helpers = execFileSync(
    '/usr/bin/find',
    [join(CONTENTS, 'Resources', 'node_modules', 'node-pty'), '-name', 'spawn-helper'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  for (const helper of helpers) chmodSync(helper, 0o755);
  console.log(`  spawn-helper: ${String(helpers.length)} made executable`);
}

/**
 * The launcher.
 *
 * A shell script rather than a copied node binary. Copying node into the bundle would double
 * its size and pin a runtime that the user upgrades independently; the identity that matters to
 * TCC comes from the bundle, and a child process inherits it either way.
 */
writeFileSync(
  join(CONTENTS, 'MacOS', 'tabtermd'),
  `#!/bin/sh
# Launcher for the TabTerm daemon. launchd starts this, never a Homebrew node directly, so the
# privacy identity stays attached to ${BUNDLE_ID}.
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
NODE="\${TABTERM_NODE:-$(command -v node)}"
if [ -z "$NODE" ]; then
  echo "TabTerm: no node on PATH. Set TABTERM_NODE to a Node 22+ binary." >&2
  exit 1
fi
export NODE_PATH="$DIR/node_modules"
exec "$NODE" "$DIR/daemon/main.js" "$@"
`,
  { mode: 0o755 },
);

/**
 * Strip extended attributes before signing.
 *
 * codesign refuses a bundle carrying "resource fork, Finder information, or similar detritus",
 * and a build tree under a synced folder picks those up on its own: this repository lives under
 * ~/Documents, which is iCloud-managed, so the bundle arrives with `com.apple.FinderInfo` and a
 * fileprovider attribute attached before the script ever touches it.
 */
execFileSync('/usr/bin/xattr', ['-cr', APP]);

// Sign. Ad-hoc is enough for TCC to have something stable to attach to; a Developer ID is
// required to distribute, and notarization on top of that.
const signWith = identity ?? '-';
try {
  execFileSync(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', signWith, '--identifier', BUNDLE_ID, APP],
    { stdio: 'pipe' },
  );
  console.log(`  signed with: ${identity ? identity : 'ad-hoc (-)'}`);
} catch (e) {
  console.error(`  codesign failed: ${String(e.message ?? e).slice(0, 300)}`);
  process.exit(1);
}

// codesign reports on stderr, which is easy to read from the wrong stream and then believe the
// identifier is missing when it is right there.
const verified = execFileSync('/bin/sh', ['-c', `/usr/bin/codesign -dv "${APP}" 2>&1`], {
  encoding: 'utf8',
});
const reported = /Identifier=(\S+)/.exec(verified)?.[1];
console.log(`  bundle: ${APP}`);
console.log(`  identifier: ${reported ?? 'unknown'}`);
if (reported !== BUNDLE_ID) {
  console.error(`  the signed identifier is not ${BUNDLE_ID}. TCC grants would not attach.`);
  process.exit(1);
}

if (!identity) {
  console.log('');
  console.log('  Ad-hoc signed. Good enough for a stable TCC identity on this machine.');
  console.log('  To distribute, sign with a Developer ID and notarize:');
  console.log(
    '    node scripts/build-app-bundle.mjs --sign "Developer ID Application: NAME (TEAMID)"',
  );
  console.log('    xcrun notarytool submit dist/TabTerm.app --keychain-profile <profile> --wait');
  console.log('    xcrun stapler staple dist/TabTerm.app');
}
