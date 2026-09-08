import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
 * The identity has to survive an update, which is the whole point of having one.
 *
 * A privacy decision attaches to the signature of the binary inside the bundle. The build used to
 * copy in whatever node the machine had, so an unrelated `brew upgrade` moved that signature and
 * threw the decision away: the person was asked for access again, with nothing on screen to
 * connect it to anything they had done. Reported as node asking on every single agent launch.
 *
 * These build real bundles, because the failure was never in the decision and always in the
 * plumbing around it. The first version of this fix read the runtime it meant to keep out of a
 * directory the build had already deleted, and reported success while replacing it every time.
 */
describe.skipIf(!onMac)('the identity survives the machine changing underneath it', () => {
  const build = (out: string, extra: string[] = [], node?: string): string => {
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'build-app-bundle.mjs'), '--out', out, ...extra],
      {
        stdio: 'pipe',
        env: node === undefined ? process.env : { ...process.env, TABTERM_NODE: node },
      },
    );
    return createHash('sha256')
      .update(readFileSync(join(out, 'Contents', 'MacOS', 'node')))
      .digest('hex');
  };

  /** A second real node to stand in for the one the machine had before an upgrade. */
  const otherNode = ['/opt/homebrew/opt/node@20/bin/node', '/opt/homebrew/opt/node@22/bin/node']
    .filter((p) => existsSync(p))
    .find((p) => p !== process.execPath);

  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tt-bundle-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(otherNode === undefined)('rebuilding keeps the runtime, so the signature holds', () => {
    const out = join(dir, 'rebuild.app');
    const first = build(out);
    // The build deletes the bundle before it looks for a runtime to keep, so the one worth
    // keeping has to be carried across that. Reading it afterwards finds nothing.
    expect(build(out, [], otherNode)).toBe(first);
  });

  it.skipIf(otherNode === undefined)('and a build with no bundle adopts the installed one', () => {
    // dist/ is a build directory: a clean wipes it and a fresh clone never had it. What macOS
    // remembers is the installed copy, so that is what the installer hands over.
    const source = join(dir, 'source.app');
    const fresh = join(dir, 'fresh.app');
    const want = build(source);
    const got = build(
      fresh,
      ['--adopt-runtime', join(source, 'Contents', 'MacOS', 'node')],
      otherNode,
    );
    expect(got).toBe(want);
  });

  it.skipIf(otherNode === undefined)('unless asked for a new one outright', () => {
    // Without an escape hatch the bundle could never move off a runtime that had stopped working.
    const out = join(dir, 'refresh.app');
    build(out);
    build(out, ['--refresh-runtime'], otherNode);
    const version = execFileSync(
      join(out, 'Contents', 'MacOS', 'node'),
      ['-p', 'process.version'],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(version).toBe(
      execFileSync(otherNode as string, ['-p', 'process.version'], { encoding: 'utf8' }).trim(),
    );
  });

  it('replaces a runtime that cannot do what the daemon needs', () => {
    // Keeping one forever is only safe while it still works. A bundle that cannot start is worse
    // than a prompt, so a broken one is not kept out of respect for its signature.
    const out = join(dir, 'broken.app');
    build(out);
    writeFileSync(join(out, 'Contents', 'MacOS', 'node'), 'not a runtime');
    build(out);
    const version = execFileSync(
      join(out, 'Contents', 'MacOS', 'node'),
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

  it('hands the installed runtime to the build, so an update keeps the approval', () => {
    // Without this the build has nothing to keep on a fresh clone or after a clean, and copies
    // in today's node, which moves the signature the privacy decision is attached to.
    expect(install).toContain('--adopt-runtime');
  });

  it('substitutes that runtime into the launchd definition, not the bare one', () => {
    expect(install).toMatch(/s\|__NODE__\|\$LAUNCH_NODE\|g/);
  });

  it('keeps a working identity when it cannot rebuild one', () => {
    /**
     * A failed build is a reason to leave the identity alone, not a reason to throw it away.
     *
     * The fallback to the bare interpreter is right for a machine that has never had a bundle and
     * wrong for one that has: it silently undoes the thing the bundle exists for, and the only
     * sign is one line in a long install. The symptom arrives days later as macOS asking for
     * permission on every agent launch. Observed from a transient failure on a machine whose
     * installed bundle was perfectly good.
     */
    expect(install).toContain('keeping the one already installed');
    // And the branch is guarded by actually running it, not by the directory existing.
    expect(install).toMatch(/elif "\$APP\/Contents\/MacOS\/node" -e/);
  });

  it('falls back rather than failing to install, and says what that costs', () => {
    // A machine where the bundle cannot be built still gets a working TabTerm. It gets the old
    // prompts too, and is told so rather than left to discover it.
    expect(install).toContain('falling back to $NODE');
    expect(install).toMatch(/privacy prompts will say/);
  });
});
