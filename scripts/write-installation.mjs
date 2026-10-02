import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeJson } from './updater/state.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
writeJson(process.argv[2], {
  version: pkg.version,
  node: process.argv[3],
  port: 7377,
  databaseSha256: createHash('sha256')
    .update(readFileSync(join(root, 'daemon/src/database.ts')))
    .digest('hex'),
});
