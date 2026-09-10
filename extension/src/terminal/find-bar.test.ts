import { describe, expect, it, vi } from 'vitest';
import { FindBar, type FindTarget } from './find-bar.js';

/**
 * Finding text in a terminal, which the browser cannot do for us.
 *
 * Chrome's find reads the page and the terminal is a canvas, so its bar opens and matches nothing.
 * Drawing with elements would not fix it either: xterm renders the rows in view, and the scrollback
 * is the part worth searching. So this asks the emulator, and what follows is the part of that
 * which needs no emulator to check.
 *
 * Driven through stand-ins rather than a real document, because a browser is a large dependency to
 * add for six listeners, and the listeners are the whole of what this class is.
 */
type Handler = (e: {
  key?: string;
  shiftKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}) => void;

const fake = () => {
  const on = new Map<string, Handler>();
  return {
    hidden: true,
    value: '',
    textContent: '',
    addEventListener: (name: string, fn: Handler) => on.set(name, fn),
    focus: vi.fn(),
    select: vi.fn(),
    fire(name: string, e: { key?: string; shiftKey?: boolean } = {}) {
      on.get(name)?.({ ...e, preventDefault: () => {}, stopPropagation: () => {} });
    },
  };
};

const setup = () => {
  const calls: { term: string; back?: boolean }[] = [];
  let didClear = false;
  let didFocus = false;
  const target: FindTarget = {
    find: (term, opts) => {
      calls.push({ term, ...(opts ?? {}) });
      return term === 'hit';
    },
    clearFind: () => {
      didClear = true;
    },
    focus: () => {
      didFocus = true;
    },
  };
  const root = fake();
  const input = fake();
  const count = fake();
  const next = fake();
  const previous = fake();
  const close = fake();
  const bar = new FindBar({
    target: () => target,
    root: root as unknown as HTMLElement,
    input: input as unknown as HTMLInputElement,
    count: count as unknown as HTMLElement,
    next: next as unknown as HTMLElement,
    previous: previous as unknown as HTMLElement,
    close: close as unknown as HTMLElement,
  });
  return {
    bar,
    target,
    calls,
    cleared: () => didClear,
    focused: () => didFocus,
    root,
    input,
    count,
    next,
    previous,
    close,
  };
};

describe('the find bar', () => {
  it('opens with whatever was selected, so a word can be looked up without retyping it', () => {
    const { bar, input } = setup();
    bar.show('needle');
    expect(input.value).toBe('needle');
    expect(bar.isOpen).toBe(true);
  });

  it('does not take a multi-line selection as a search term', () => {
    // Selecting three lines and pressing the key means "search", not "search for these lines".
    const { bar, input } = setup();
    bar.show('one\ntwo');
    expect(input.value).toBe('');
  });

  it('searches forward on Return and backward on Shift Return', () => {
    const { bar, calls, input } = setup();
    bar.show('hit');
    calls.length = 0;
    input.fire('keydown', { key: 'Enter' });
    input.fire('keydown', { key: 'Enter', shiftKey: true });
    expect(calls.map((c) => c.back === true)).toEqual([false, true]);
  });

  it('closes on Escape, clears what it lit up, and gives the keyboard back', () => {
    const { bar, cleared, focused, input } = setup();
    bar.show('hit');
    input.fire('keydown', { key: 'Escape' });
    expect(bar.isOpen).toBe(false);
    expect(cleared()).toBe(true);
    // Otherwise the next thing typed goes into a box nobody can see.
    expect(focused()).toBe(true);
  });

  it('says when there is nothing to find, rather than leaving the screen unchanged', () => {
    const { bar, count, input } = setup();
    bar.show('');
    input.value = 'miss';
    input.fire('input');
    expect(count.textContent).toBe('no matches');
  });

  it('counts matches the way somebody reads them, from one', () => {
    const { bar, count } = setup();
    bar.show('hit');
    bar.showResults({ resultIndex: 2, resultCount: 12 });
    expect(count.textContent).toBe('3 of 12');
  });

  it('closes itself when the pane it was searching has gone', () => {
    const { bar } = setup();
    bar.show('hit');
    bar.paneGone();
    expect(bar.isOpen).toBe(false);
  });

  it('asks for the pane at the moment of searching, never the one it was built with', () => {
    /*
     * Panes are split, closed and swapped underneath this, and a target held from construction is
     * stale in every one of those cases.
     */
    let current: FindTarget | null = null;
    const seen: string[] = [];
    const input = fake();
    const bar = new FindBar({
      target: () => current,
      root: fake() as unknown as HTMLElement,
      input: input as unknown as HTMLInputElement,
      count: fake() as unknown as HTMLElement,
      next: fake() as unknown as HTMLElement,
      previous: fake() as unknown as HTMLElement,
      close: fake() as unknown as HTMLElement,
    });
    current = { find: (t) => (seen.push(`a:${t}`), true), clearFind: vi.fn(), focus: vi.fn() };
    bar.show('x');
    current = { find: (t) => (seen.push(`b:${t}`), true), clearFind: vi.fn(), focus: vi.fn() };
    input.fire('keydown', { key: 'Enter' });
    expect(seen).toEqual(['a:x', 'b:x']);
  });
});
