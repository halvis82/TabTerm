import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { COMPANION_COMPATIBILITY, parseCompanionRelease } from '../shared/src/updates.ts';

export function packageCompanion(root = '.', output = join(root, 'dist'), ref = 'HEAD') {
  const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 200 * 1024 * 1024 });
  const commit = git('rev-parse', `${ref}^{commit}`).toString().trim();
  const pkg = JSON.parse(git('show', `${commit}:package.json`).toString());
  if (pkg.version !== JSON.parse(readFileSync(join(root, 'package.json'))).version)
    throw new Error('Commit the release version before packaging companion source');
  const files = git('ls-tree', '-r', '--name-only', commit).toString().trim().split('\n');
  if (
    files.some((p) =>
      /(^|\/)(AGENTS|demo|node_modules|\.git)(\/|$)|(^|\/)\.env($|\.)|\.(pem|key|zip)$/.test(p),
    )
  )
    throw new Error('Private or generated files found in release source');
  const bytes = gzipSync(git('archive', '--format=tar', '--prefix=tabterm/', commit), { level: 9 });
  const manifest = parseCompanionRelease({
    schema: 1,
    version: pkg.version,
    tag: `v${pkg.version}`,
    commit,
    source: {
      url: `https://github.com/halvis82/TabTerm/releases/download/v${pkg.version}/tabterm-companion-${pkg.version}.tar.gz`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    },
    compatibility: COMPANION_COMPATIBILITY,
  });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, `tabterm-companion-${pkg.version}.tar.gz`), bytes);
  writeFileSync(join(output, 'companion-release.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(packageCompanion(), null, 2));
