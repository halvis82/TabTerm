import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from './paths.js';

const root = mkdtempSync(join(tmpdir(), 'tt-paths-'));
mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'src', 'main.ts'), 'x');
writeFileSync(join(root, 'README.md'), 'x');
mkdirSync(join(root, 'a dir with spaces'));
writeFileSync(join(root, "weird';name.txt"), 'x');

const find = (rs: Awaited<ReturnType<typeof resolvePaths>>, c: string) =>
  rs.find((r) => r.candidate === c);

describe('path resolution', () => {
  it('resolves a relative path against the session directory', async () => {
    const rs = await resolvePaths(['src/main.ts'], root);
    const hit = find(rs, 'src/main.ts');
    expect(hit?.exists).toBe(true);
    expect(hit?.isDirectory).toBe(false);
    expect(hit?.absolute).toBe(join(root, 'src', 'main.ts'));
  });

  it('resolves an absolute path', async () => {
    const rs = await resolvePaths([join(root, 'README.md')], '/');
    expect(find(rs, join(root, 'README.md'))?.exists).toBe(true);
  });

  it('distinguishes a directory from a file', async () => {
    const rs = await resolvePaths(['src', 'src/main.ts'], root);
    expect(find(rs, 'src')?.isDirectory).toBe(true);
    expect(find(rs, 'src/main.ts')?.isDirectory).toBe(false);
  });

  it('expands ~ to the home directory', async () => {
    const rs = await resolvePaths(['~'], root);
    expect(find(rs, '~')?.absolute).toBe(homedir());
    expect(find(rs, '~')?.isDirectory).toBe(true);
  });

  it('extracts line and column from a compiler-style reference', async () => {
    const rs = await resolvePaths(['src/main.ts:42:7', 'src/main.ts:9'], root);
    const withCol = find(rs, 'src/main.ts:42:7');
    expect(withCol?.exists).toBe(true);
    expect(withCol?.line).toBe(42);
    expect(withCol?.column).toBe(7);

    const lineOnly = find(rs, 'src/main.ts:9');
    expect(lineOnly?.line).toBe(9);
    expect(lineOnly?.column).toBeUndefined();
  });

  it('handles paths containing spaces', async () => {
    const rs = await resolvePaths(['a dir with spaces'], root);
    expect(find(rs, 'a dir with spaces')?.isDirectory).toBe(true);
  });

  it('handles a filename containing shell metacharacters', async () => {
    // Never interpolated into a shell string, so a quote in a name is just a character.
    const rs = await resolvePaths(["weird';name.txt"], root);
    expect(find(rs, "weird';name.txt")?.exists).toBe(true);
  });

  it('reports nonexistent paths as not existing rather than omitting them', async () => {
    const rs = await resolvePaths(['src/nope.ts'], root);
    expect(find(rs, 'src/nope.ts')?.exists).toBe(false);
  });

  it('rejects hostile candidates outright', async () => {
    const rs = await resolvePaths(['', 'a\0b', 'x'.repeat(5000)], root);
    expect(rs.find((r) => r.candidate.includes('\0'))).toBeUndefined();
    expect(rs.find((r) => r.candidate === '')).toBeUndefined();
    expect(rs.find((r) => r.candidate.length > 4096)).toBeUndefined();
  });

  it('always produces an absolute path when it produces anything', async () => {
    const rs = await resolvePaths(['src/main.ts', '../..', '~/', 'README.md'], root);
    expect(rs.every((r) => r.absolute.startsWith('/'))).toBe(true);
  });

  it('caps how many candidates one request can ask about', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `file-${String(i)}.txt`);
    const rs = await resolvePaths(many, root);
    expect(rs.length).toBeLessThanOrEqual(200);
  });

  it('deduplicates repeated candidates', async () => {
    const rs = await resolvePaths(['src/main.ts', 'src/main.ts', 'src/main.ts'], root);
    expect(rs.filter((r) => r.candidate === 'src/main.ts')).toHaveLength(1);
  });
});
