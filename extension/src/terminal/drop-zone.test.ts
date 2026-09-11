import { describe, it, expect } from 'vitest';
import {
  dragCarriesFiles,
  droppedText,
  whatIsCarried,
  hasItsOwnDropTarget,
  DragDepth,
} from './drop-zone.js';

const ESC = String.fromCharCode(27);

describe('what a drag is carrying', () => {
  it('recognizes files', () => {
    expect(dragCarriesFiles(['Files'])).toBe(true);
    expect(dragCarriesFiles(['text/plain', 'Files'])).toBe(true);
  });

  it('does not mistake dragged text for a file', () => {
    expect(dragCarriesFiles(['text/plain', 'text/uri-list'])).toBe(false);
    expect(dragCarriesFiles([])).toBe(false);
    expect(dragCarriesFiles(undefined)).toBe(false);
  });
});

describe('showing that the window will take a drop', () => {
  it('lights up on the way in and stays lit across child elements', () => {
    const depth = new DragDepth();
    expect(depth.enter()).toBe(true);
    expect(depth.enter()).toBe(false);
    expect(depth.leave()).toBe(false);
    expect(depth.active).toBe(true);
  });

  it('goes out only when the drag has really left', () => {
    const depth = new DragDepth();
    depth.enter();
    depth.enter();
    depth.leave();
    expect(depth.leave()).toBe(true);
    expect(depth.active).toBe(false);
  });

  it('never counts below nothing, however the events arrive', () => {
    const depth = new DragDepth();
    expect(depth.leave()).toBe(true);
    expect(depth.enter()).toBe(true);
  });

  it('goes out at once on a drop', () => {
    const depth = new DragDepth();
    depth.enter();
    depth.enter();
    depth.end();
    expect(depth.active).toBe(false);
  });
});

describe('text dropped on the window', () => {
  it('stages one line, so it is never run on arrival', () => {
    expect(droppedText('one\ntwo')).toBe('one two');
  });

  it('drops the escape sequences with it', () => {
    expect(droppedText(`a${ESC}[31mb`)).toBe('a[31mb');
  });

  it('says there is nothing to stage rather than staging nothing', () => {
    expect(droppedText('   ')).toBeNull();
  });
});

describe('what is worth taking from a drag', () => {
  it('takes files over text, because a dragged file carries its name as text too', () => {
    expect(whatIsCarried(['Files', 'text/plain'])).toBe('files');
  });

  it('takes dragged text', () => {
    expect(whatIsCarried(['text/plain'])).toBe('text');
    expect(whatIsCarried(['text/uri-list'])).toBe('text');
  });

  it('takes nothing from a drag carrying neither', () => {
    expect(whatIsCarried(['application/x-moz-nativeimage'])).toBeNull();
    expect(whatIsCarried([])).toBeNull();
  });
});

describe('a drop that something inside the window already handles', () => {
  const on = (matches: string[]) => ({
    closest: (selector: string) => (matches.includes(selector) ? {} : null),
  });

  it('leaves a text field to itself', () => {
    // The launcher's path box takes a dropped path already. The window taking it as well put the
    // same text at the prompt of the pane behind the start screen.
    expect(hasItsOwnDropTarget(on(['input, textarea, [contenteditable="true"]']))).toBe(true);
  });

  it('takes a drop on anything else', () => {
    expect(hasItsOwnDropTarget(on([]))).toBe(false);
    expect(hasItsOwnDropTarget(null)).toBe(false);
  });
});
