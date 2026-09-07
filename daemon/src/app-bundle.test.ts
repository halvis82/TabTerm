import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = join(ROOT, 'dist', 'TabTerm.app');
const onMac = process.platform === 'darwin';

/**
 * The bundle exists for exactly one reason, and it has to be able to do that one thing.
 *
 * macOS attaches a privacy decision to a process's **executable image**. Launching Homebrew's node
 * directly makes every prompt read "node" and records the decision against a bare path with no
 * code requirement, which macOS does not honor on the next launch: the prompt came back every
 * single time an agent was started, which is not something anybody will tolerate.
 *
 * The trap this guards is subtle and was live for months. The bundle was built, signed, and
 * correct, and its executable was a shell script that exec'd node. A script's executable image is
 * the interpreter, and an exec replaces the image with one outside the bundle, so the process
 * macOS saw was never in TabTerm.app and the bundle bought nothing at all.
 */
describe.skipIf(!onMac)('the app bundle can hold a privacy identity', () => {
  const built = existsSync(join(APP, 'Contents', 'Info.plist'));

  it.skipIf(!built)('its executable is a real binary, not a script', () => {
    const exe = join(APP, 'Contents', 'MacOS', 'node');
    expect(existsSync(exe)).toBe(true);
    const kind = execFileSync('/usr/bin/file', [exe], { encoding: 'utf8' });
    expect(kind).toContain('Mach-O');
    expect(kind).not.toContain('script');
  });

  it.skipIf(!built)('and the bundle names that binary as the one it runs', () => {
    // A CFBundleExecutable naming anything else leaves the identity attached to nothing.
    const plist = readFileSync(join(APP, 'Contents', 'Info.plist'), 'utf8');
    expect(plist).toMatch(/<key>CFBundleExecutable<\/key><string>node<\/string>/);
    expect(plist).toMatch(/<key>CFBundleIdentifier<\/key><string>com\.tabterm\.daemon<\/string>/);
  });

  it.skipIf(!built)('signed under the identifier the decision attaches to', () => {
    // `codesign -dv` reports on stderr, which is where the identifier is.
    const out = execFileSync('/bin/sh', ['-c', `/usr/bin/codesign -dv '${APP}' 2>&1`], {
      encoding: 'utf8',
    });
    expect(out).toContain('Identifier=com.tabterm.daemon');
  });

  it.skipIf(!built)("seals nothing of TabTerm's own, so an update keeps the approval", () => {
    /**
     * `codesign --deep` seals everything under the bundle, so anything of ours inside it makes
     * the identity change whenever that changes. With the daemon copied in, the privacy approval
     * was asked again on every single update: the complaint the bundle exists to answer, at a
     * slower rate. Measured: one line changed in the daemon moved the bundle's hash.
     */
    const resources = join(APP, 'Contents', 'Resources');
    expect(existsSync(join(resources, 'daemon'))).toBe(false);
    expect(existsSync(join(resources, 'node_modules'))).toBe(false);
  });

  it.skipIf(!built)('and it actually runs, which the rpath rewrite can break', () => {
    // `install_name_tool` invalidates a signature and macOS kills an invalidly signed binary on
    // launch rather than refusing it with an error, so this is the only thing that proves it.
    const version = execFileSync(
      join(APP, 'Contents', 'MacOS', 'node'),
      ['-p', 'process.version'],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(version).toMatch(/^v\d+\./);
  });
});

/**
 * And the installer has to actually use it, which is the half that was missing.
 */
describe('the installer launches the daemon through the bundle', () => {
  const install = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');

  it('builds the bundle and points launchd at the binary inside it', () => {
    expect(install).toContain('build-app-bundle.mjs');
    expect(install).toContain('$APP/Contents/MacOS/node');
    expect(install).toContain('LAUNCH_NODE');
  });

  it('substitutes that runtime into the launchd definition, not the bare one', () => {
    expect(install).toMatch(/s\|__NODE__\|\$LAUNCH_NODE\|g/);
  });

  it('falls back rather than failing to install, and says what that costs', () => {
    // A machine where the bundle cannot be built still gets a working TabTerm. It gets the old
    // prompts too, and is told so rather than left to discover it.
    expect(install).toContain('falling back to $NODE');
    expect(install).toMatch(/privacy prompts will say/);
  });
});
