// Refuse to build with a non-text source file.
//
// A NUL byte written into a template string once made git treat a source file as binary and
// made grep silently return nothing for it. Harmless at runtime, expensive to notice.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['daemon/src', 'extension/src', 'shared/src', 'shell', 'scripts', 'docs'];
const TEXT = /\.(ts|tsx|js|mjs|json|md|zsh|sh|html|css)$/;
const bad = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (TEXT.test(name)) {
      const buf = readFileSync(path);
      const nul = buf.indexOf(0);
      if (nul !== -1) bad.push({ path, offset: nul });
    }
  }
}

for (const root of ROOTS) walk(root);

if (bad.length > 0) {
  console.error('\nSource files contain NUL bytes and are no longer text:\n');
  for (const b of bad) console.error(`  ${b.path} at byte ${String(b.offset)}`);
  console.error('\nThis breaks grep and makes git treat the file as binary.\n');
  process.exit(1);
}
console.log(`checked ${String(ROOTS.length)} source roots, all text`);
