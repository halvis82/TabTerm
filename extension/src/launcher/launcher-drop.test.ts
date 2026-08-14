import { describe, expect, it } from 'vitest';
import { pathFromDrop } from './launcher.js';

/** A DataTransfer is not available outside a browser, and only two methods are used. */
const transfer = (values: Record<string, string>): DataTransfer =>
  ({ getData: (type: string) => values[type] ?? '' }) as unknown as DataTransfer;

describe('taking a path out of a drop', () => {
  it('reads a file URL, which is what another application hands over', () => {
    expect(pathFromDrop(transfer({ 'text/uri-list': 'file:///Users/someone/Projects/app' }))).toBe(
      '/Users/someone/Projects/app',
    );
  });

  it('decodes a path with a space, which would otherwise not exist', () => {
    expect(pathFromDrop(transfer({ 'text/uri-list': 'file:///Users/someone/My%20Work' }))).toBe(
      '/Users/someone/My Work',
    );
  });

  it('takes the first of several dropped items', () => {
    expect(pathFromDrop(transfer({ 'text/uri-list': 'file:///one\nfile:///two' }))).toBe('/one');
  });

  it('accepts a plain path dragged as text', () => {
    expect(pathFromDrop(transfer({ 'text/plain': '/etc/hosts' }))).toBe('/etc/hosts');
    expect(pathFromDrop(transfer({ 'text/plain': '~/Projects' }))).toBe('~/Projects');
  });

  it('refuses text that is not a path', () => {
    // Dragging a sentence into the box must not open a terminal in a folder named after it.
    expect(pathFromDrop(transfer({ 'text/plain': 'some words' }))).toBe('');
  });

  it('refuses a drop carrying nothing, which is what a Finder drag gives. See ADR-0014', () => {
    expect(pathFromDrop(transfer({}))).toBe('');
    expect(pathFromDrop(null)).toBe('');
  });

  it('survives a malformed URL rather than throwing into the drop handler', () => {
    expect(pathFromDrop(transfer({ 'text/uri-list': 'file://[bad' }))).toBe('');
  });
});
