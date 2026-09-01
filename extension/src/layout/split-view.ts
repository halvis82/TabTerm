import type { LayoutNode } from '@tabterm/shared';

/**
 * Renders a layout tree as nested flex boxes, with draggable dividers.
 *
 * The tree is authoritative and lives in the daemon. This turns it into DOM and reports back
 * what the user does to it. It deliberately holds no terminal state of its own: it hands out
 * one container element per pane and lets the caller decide what goes inside.
 *
 * Only visible panes get a renderer, so a maximized pane costs nothing for the ones it hides.
 * See docs/07-terminal-fidelity.md §5.
 */

const DIVIDER_PX = 6;

export interface SplitViewOptions {
  root: HTMLElement;
  /** Called for each pane, to obtain (and reuse) its content element. */
  paneElement: (paneId: string, sessionId: string) => HTMLElement;
  onRatioChange: (paneId: string, ratio: number) => void;
  onFocusPane: (paneId: string) => void;
  onPaneResized: (paneId: string, element: HTMLElement) => void;
}

export class SplitView {
  readonly #opts: SplitViewOptions;
  #layout: LayoutNode | null = null;
  #focused: string | null = null;
  #maximized: string | null = null;
  #keyboardLocked = false;
  readonly #wrappers = new Map<string, HTMLElement>();
  #resizeObserver: ResizeObserver;

  constructor(opts: SplitViewOptions) {
    this.#opts = opts;
    this.#resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const paneId = (entry.target as HTMLElement).dataset['paneId'];
        if (paneId) this.#opts.onPaneResized(paneId, entry.target as HTMLElement);
      }
    });
  }

  get focused(): string | null {
    return this.#focused;
  }

  get maximized(): string | null {
    return this.#maximized;
  }

  get paneIds(): string[] {
    return [...this.#wrappers.keys()];
  }

  render(layout: LayoutNode): void {
    this.#layout = layout;
    const live = new Set(collectPanes(layout));

    // Drop wrappers for panes that no longer exist, so their terminals can be disposed.
    for (const [paneId, el] of this.#wrappers) {
      if (!live.has(paneId)) {
        this.#resizeObserver.unobserve(el);
        this.#wrappers.delete(paneId);
      }
    }
    if (this.#focused && !live.has(this.#focused)) this.#focused = null;
    if (this.#maximized && !live.has(this.#maximized)) this.#maximized = null;

    this.#opts.root.replaceChildren(this.#build(layout));
    if (!this.#focused) {
      const first = collectPanes(layout)[0];
      if (first) this.focus(first);
    }
  }

  focus(paneId: string): void {
    this.#focused = paneId;
    for (const [id, el] of this.#wrappers) el.classList.toggle('focused', id === paneId);
    this.#opts.onFocusPane(paneId);
  }

  /** Temporarily give one pane the whole tab. Escape restores the layout. */
  toggleMaximize(paneId: string | null): void {
    this.#maximized = this.#maximized === paneId ? null : paneId;
    if (this.#layout) this.render(this.#layout);
    if (this.#focused) this.focus(this.#focused);
  }

  /**
   * Fullscreen focus mode, which is the only way a page can receive Command+W.
   *
   * `navigator.keyboard.lock()` captures browser and system shortcuts, but only while the page
   * is in fullscreen. In a normal tab those keys never reach JavaScript at all, so this is the
   * one context where a terminal can have the whole keyboard. See docs/10-limitations.md tier 0.4.
   *
   * The lock is always released on the way out, including on paths that are not a clean exit,
   * because leaving it held would take Command+W away from the whole browser.
   */
  async enterFocusMode(paneId: string): Promise<boolean> {
    try {
      await this.#opts.root.requestFullscreen();
    } catch {
      return false;
    }
    this.#maximized = paneId;
    if (this.#layout) this.render(this.#layout);
    this.focus(paneId);

    try {
      await navigator.keyboard?.lock(['KeyW', 'KeyT', 'KeyN', 'KeyQ']);
      this.#keyboardLocked = true;
    } catch {
      // Fullscreen still works without the lock; only the reserved keys stay with Chrome.
      this.#keyboardLocked = false;
    }
    return true;
  }

  async exitFocusMode(): Promise<void> {
    if (this.#keyboardLocked) {
      try {
        navigator.keyboard?.unlock();
      } catch {
        /* nothing useful to do, and the browser releases it on exit anyway */
      }
      this.#keyboardLocked = false;
    }
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* already gone */
      }
    }
    this.#maximized = null;
    if (this.#layout) this.render(this.#layout);
    if (this.#focused) this.focus(this.#focused);
  }

  get inFocusMode(): boolean {
    return document.fullscreenElement !== null && this.#maximized !== null;
  }

  #build(node: LayoutNode): HTMLElement {
    if (this.#maximized) {
      const only = this.#paneWrapper(this.#maximized, this.#sessionFor(this.#maximized) ?? '');
      const box = document.createElement('div');
      box.className = 'split-node maximized';
      box.append(only);
      return box;
    }
    return this.#buildNode(node);
  }

  #buildNode(node: LayoutNode): HTMLElement {
    if (node.type === 'terminal') {
      const wrapper = this.#paneWrapper(node.paneId, node.sessionId);
      this.#applyLabel(wrapper, node.label, node.labelColor);
      return wrapper;
    }

    const box = document.createElement('div');
    box.className = `split-node split-${node.direction}`;

    const first = this.#buildNode(node.children[0]);
    const second = this.#buildNode(node.children[1]);
    const divider = document.createElement('div');
    divider.className = `divider divider-${node.direction}`;

    const pct = node.ratio * 100;
    first.style.flex = `0 0 calc(${String(pct)}% - ${String(DIVIDER_PX / 2)}px)`;
    second.style.flex = '1 1 0';

    this.#wireDivider(divider, box, node);
    box.append(first, divider, second);
    return box;
  }

  /**
   * Dragging is applied optimistically to the DOM and reported once on release.
   *
   * Sending every intermediate ratio would produce a resize storm at the PTY, and the shell
   * only cares about the size you settle on. See docs/07-terminal-fidelity.md §4.
   */
  #wireDivider(divider: HTMLElement, box: HTMLElement, node: LayoutNode & { type: 'split' }): void {
    divider.addEventListener('pointerdown', (down: PointerEvent) => {
      down.preventDefault();
      divider.setPointerCapture(down.pointerId);
      divider.classList.add('dragging');

      const horizontal = node.direction === 'horizontal';
      const rect = box.getBoundingClientRect();
      const total = horizontal ? rect.width : rect.height;
      const first = box.firstElementChild as HTMLElement;
      let ratio = node.ratio;

      const move = (e: PointerEvent) => {
        const offset = horizontal ? e.clientX - rect.left : e.clientY - rect.top;
        ratio = Math.min(0.95, Math.max(0.05, offset / total));
        first.style.flex = `0 0 calc(${String(ratio * 100)}% - ${String(DIVIDER_PX / 2)}px)`;
      };
      const up = () => {
        divider.classList.remove('dragging');
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        const anchor = leftmostPane(node.children[0]);
        if (anchor) this.#opts.onRatioChange(anchor, ratio);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
    });
  }

  #paneWrapper(paneId: string, sessionId: string): HTMLElement {
    let wrapper = this.#wrappers.get(paneId);
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'pane';
      wrapper.dataset['paneId'] = paneId;
      wrapper.append(this.#opts.paneElement(paneId, sessionId));
      wrapper.addEventListener('pointerdown', () => this.focus(paneId));
      this.#wrappers.set(paneId, wrapper);
      this.#resizeObserver.observe(wrapper);
    }
    wrapper.classList.toggle('focused', this.#focused === paneId);
    return wrapper;
  }

  /**
   * Draw the pane's name, quietly.
   *
   * A label exists to tell four shells apart at a glance, so it sits in a corner at low opacity
   * and never competes with the output. Written with `textContent`, since it is text somebody
   * typed and has no business being markup.
   */
  #applyLabel(wrapper: HTMLElement, label?: string, color?: string): void {
    const existing = wrapper.querySelector('.pane-label');
    if (!label) {
      existing?.remove();
      return;
    }
    const el = existing ?? document.createElement('div');
    el.className = 'pane-label';
    el.textContent = label;
    (el as HTMLElement).style.color = color ?? '';
    if (!existing) wrapper.append(el);
  }

  #sessionFor(paneId: string): string | null {
    if (!this.#layout) return null;
    const walk = (n: LayoutNode): string | null => {
      if (n.type === 'terminal') return n.paneId === paneId ? n.sessionId : null;
      return walk(n.children[0]) ?? walk(n.children[1]);
    };
    return walk(this.#layout);
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#wrappers.clear();
  }
}

export function collectPanes(node: LayoutNode): string[] {
  if (node.type === 'terminal') return [node.paneId];
  return [...collectPanes(node.children[0]), ...collectPanes(node.children[1])];
}

function leftmostPane(node: LayoutNode): string | null {
  if (node.type === 'terminal') return node.paneId;
  return leftmostPane(node.children[0]);
}
