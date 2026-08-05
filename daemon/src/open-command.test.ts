import { describe, expect, it } from 'vitest';
import { openCommand } from './paths.js';

const opts = { editor: 'nvim', guiEditor: 'code' };

describe('open commands', () => {
  it('reveals a directory in Finder', () => {
    expect(openCommand('/tmp/dir', 'reveal-in-finder', opts)).toEqual({
      file: '/usr/bin/open',
      args: ['-R', '/tmp/dir'],
    });
  });

  it('opens a file with the system default', () => {
    expect(openCommand('/tmp/a.pdf', 'default-app', opts)).toEqual({
      file: '/usr/bin/open',
      args: ['/tmp/a.pdf'],
    });
  });

  it('opens a terminal editor at the right line', () => {
    expect(openCommand('/tmp/a.ts', 'editor', { ...opts, line: 42 })).toEqual({
      file: 'nvim',
      args: ['+42', '/tmp/a.ts'],
    });
  });

  it('omits the line argument when no line was printed', () => {
    expect(openCommand('/tmp/a.ts', 'editor', opts)).toEqual({
      file: 'nvim',
      args: ['/tmp/a.ts'],
    });
  });

  it('opens a GUI editor at line and column', () => {
    expect(openCommand('/tmp/a.ts', 'gui-editor', { ...opts, line: 42, column: 7 })).toEqual({
      file: 'code',
      args: ['-g', '/tmp/a.ts:42:7'],
    });
  });

  it('honors a configured editor rather than hardcoding one', () => {
    const custom = { editor: 'vim', guiEditor: 'subl', line: 9 };
    expect(openCommand('/tmp/a.ts', 'editor', custom)?.file).toBe('vim');
    expect(openCommand('/tmp/a.ts', 'gui-editor', custom)?.file).toBe('subl');
  });

  it('never interpolates a path into a string argument', () => {
    // Terminal output is untrusted, so a filename carrying shell metacharacters must arrive
    // as one inert argv element rather than as something a shell could reinterpret.
    const nasty = "/tmp/a'; rm -rf ~; echo '.ts";
    for (const how of ['default-app', 'reveal-in-finder', 'editor', 'gui-editor'] as const) {
      const cmd = openCommand(nasty, how, opts);
      expect(cmd).not.toBeNull();
      const carrying = cmd?.args.filter((a) => a.includes(nasty)) ?? [];
      expect(carrying.length, how).toBe(1);
      // The dangerous text is contained in exactly one element, never spliced across several.
      expect(cmd?.args.join(' ').split(nasty).length).toBe(2);
    }
  });

  it('leaves opening a new terminal to the daemon rather than running anything', () => {
    expect(openCommand('/tmp/dir', 'new-terminal', opts)).toBeNull();
  });
});
