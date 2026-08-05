import { describe, expect, it } from 'vitest';
import type { ResolvedPath } from '@tabterm/shared';
import { chooseOpenAction } from './open-action.js';

const file: ResolvedPath = {
  candidate: 'src/main.ts',
  absolute: '/p/src/main.ts',
  exists: true,
  isDirectory: false,
};
const dir: ResolvedPath = {
  candidate: 'src',
  absolute: '/p/src',
  exists: true,
  isDirectory: true,
};
const ev = (over: Partial<MouseEvent> = {}) =>
  ({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: true, ...over }) as MouseEvent;

describe('which action a click means', () => {
  it('opens a file in its default application with no extra modifier', () => {
    expect(chooseOpenAction(file, ev())).toBe('default-app');
  });

  it('opens a file in the terminal editor with Option', () => {
    expect(chooseOpenAction(file, ev({ altKey: true }))).toBe('editor');
  });

  it('opens a file in the GUI editor with Control', () => {
    expect(chooseOpenAction(file, ev({ ctrlKey: true }))).toBe('gui-editor');
  });

  it('opens a terminal beside a file with Shift', () => {
    expect(chooseOpenAction(file, ev({ shiftKey: true }))).toBe('new-terminal');
  });

  it('reveals a directory rather than trying to edit it', () => {
    // There is no sensible "open this folder in vim", so a directory never routes to an editor.
    expect(chooseOpenAction(dir, ev())).toBe('reveal-in-finder');
    expect(chooseOpenAction(dir, ev({ altKey: true }))).toBe('reveal-in-finder');
    expect(chooseOpenAction(dir, ev({ ctrlKey: true }))).toBe('reveal-in-finder');
  });

  it('still opens a terminal in a directory with Shift', () => {
    expect(chooseOpenAction(dir, ev({ shiftKey: true }))).toBe('new-terminal');
  });

  it('prefers Shift when several modifiers are held', () => {
    // Opening a terminal is the least destructive of the choices, so it wins ties.
    expect(chooseOpenAction(file, ev({ shiftKey: true, altKey: true, ctrlKey: true }))).toBe(
      'new-terminal',
    );
  });
});
