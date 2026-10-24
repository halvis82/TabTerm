import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The installer offers to silence the Control Command arrow beep by writing the person's own key
// bindings file. These run the real script on files in a temporary folder, never the real one.
const script = new URL('./key-bindings.py', import.meta.url).pathname;
const run = (...args) => execFileSync('python3', [script, ...args], { encoding: 'utf8' }).trim();
const keys = (file) =>
  JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tabterm-key-bindings-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.skipIf(process.platform !== 'darwin')('writes a fresh file when there is none', () => {
  const file = join(root, 'KeyBindings', 'DefaultKeyBinding.dict');
  expect(run('status', file)).toBe('missing');
  expect(run('install', file)).toBe('added');
  expect(run('status', file)).toBe('in place');
  expect(readFileSync(file, 'utf8')).toContain('"@^\\UF702" = "noop:";');
  expect(run('install', file)).toBe('in place');
});

it.skipIf(process.platform !== 'darwin')(
  'keeps what the person bound, and backs the file up first',
  () => {
    const file = join(root, 'DefaultKeyBinding.dict');
    writeFileSync(file, '{\n  "^w" = "deleteWordBackward:";\n  "@^\\UF703" = "moveRight:";\n}\n');
    expect(run('status', file)).toBe('taken');
    expect(run('install', file)).toBe('added, and left keys bound to something else');
    const after = keys(file);
    expect(after['^w']).toBe('deleteWordBackward:');
    expect(after['@^']).toBe('moveRight:');
    expect(after['@^']).toBe('noop:');
    expect(after['@^']).toBe('noop:');
    expect(existsSync(`${file}.before-tabterm`)).toBe(true);
  },
);
