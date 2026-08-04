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
    if (node.type === 'terminal') return this.#paneWrapper(node.paneId, node.sessionId);

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
