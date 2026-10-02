import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Extract only ordinary source files from our git archive. No links or special files. */
export function extractSource(gzip, destination) {
  const tar = gunzipSync(gzip, { maxOutputLength: 200 * 1024 * 1024 });
  const seen = new Set();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((n) => n === 0)) break;
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/s, '');
    const name = text(345, 155) ? `${text(345, 155)}/${text(0, 100)}` : text(0, 100);
    const checksum = parseInt(text(148, 8).trim(), 8);
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== actual) throw new Error('Invalid source archive checksum');
    const rawSize = text(124, 12).trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('Invalid source archive size');
    const size = parseInt(rawSize, 8);
    const type = text(156, 1);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length)
      throw new Error('Invalid source archive size');
    if (type === 'g') {
      offset += Math.ceil(size / 512) * 512;
      continue;
    } // git commit PAX header, not a path
    if (
      !['', '0', '5'].includes(type) ||
      !name.startsWith('tabterm/') ||
      name.includes('\\') ||
      name.split('/').some((p) => p === '..' || p === '.') ||
      seen.has(name)
    )
      throw new Error('Unsafe source archive entry');
    seen.add(name);
    const relative = name.slice(8);
    if (
      relative &&
      (relative.startsWith('/') ||
        ['.git', 'AGENTS', 'demo', 'node_modules'].includes(relative.split('/')[0]))
    )
      throw new Error('Unexpected source archive contents');
    const path = join(destination, relative);
    if (type === '5') mkdirSync(path, { recursive: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, tar.subarray(offset, offset + size), {
        mode: parseInt(text(100, 8).trim(), 8) & 0o111 ? 0o700 : 0o600,
        flag: 'wx',
      });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!seen.has('tabterm/package.json')) throw new Error('Source archive has no package');
}
