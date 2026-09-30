import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Stage a fresh archive without changing the manifest Chrome is currently using. */
export function packageExtension(source, destination, forStore = true) {
  const staging = mkdtempSync(join(dirname(destination), '.extension-package-'));
  try {
    const contents = join(staging, 'contents');
    cpSync(source, contents, { recursive: true });
    const manifestPath = join(contents, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (forStore) {
      delete manifest.key;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const archive = join(staging, 'extension.zip');
    execFileSync('/usr/bin/zip', ['-qr', archive, '.', '-x', '*.map'], { cwd: contents });
    execFileSync('/usr/bin/unzip', ['-t', archive]);
    // Replacing only after success also prevents stale entries surviving a rebuild.
    renameSync(archive, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
