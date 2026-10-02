import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the actual informational lookup under the installer's strict shell options.
// A function substitutes for sqlite3 so no system permission database is accessed.
it.each([
  [1, ''],
  [0, '1'],
])('continues installation when the permission lookup exits %s', (code, result) => {
  const installer = readFileSync(new URL('./install.sh', import.meta.url), 'utf8');
  const lookup = installer.match(/ {2}HAD_FDA=\$\(sqlite3[\s\S]*?\)\n/)?.[0];
  expect(lookup).toBeTruthy();
  const root = mkdtempSync(join(tmpdir(), 'tabterm-install-permissions-'));
  try {
    const script = join(root, 'probe.sh');
    writeFileSync(
      script,
      `set -euo pipefail
sqlite3() { printf '%s' '${result}'; return ${code}; }
${lookup}
printf 'continued:%s' "$HAD_FDA"
`,
    );
    expect(execFileSync('/bin/bash', [script], { encoding: 'utf8' })).toBe(`continued:${result}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
