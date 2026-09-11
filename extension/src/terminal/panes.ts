import type { ResolvedPath } from '@tabterm/shared';
import { XtermController, type PaneMenuAction } from './xterm-controller.js';
import { createPathLinkProvider, findCandidates } from './path-links.js';
import { scanIsOverdue, QUIET_MS } from './link-scan.js';
import { loadHighlights, saveHighlights } from './highlights.js';
import { DEFAULT_COLOR } from './color-store.js';

/**
 * One terminal per pane.
 *
 * Panes come and go as a workspace is split and closed, so this owns the lifecycle: create a
 * renderer on demand, dispose it when its pane disappears, and never leave an orphan behind.
 */
export interface PaneHostOptions {
  onData: (paneId: string, data: string) => void;
  onResize: (paneId: string, cols: number, rows: number) => void;
  /** Clearing reaches the daemon, because the page holds only one copy of the output. */
  onClear?: (paneId: string) => void;
  resolvePaths: (paneId: string, candidates: string[]) => void;
  lookupPath: (candidate: string) => ResolvedPath | undefined;
  openPath: (paneId: string, resolved: ResolvedPath, event: MouseEvent) => void;
  openUrl: (url: string) => void;
  modifierHeld: () => boolean;
  /** Pane-level entries for the right-click menu, asked for at the moment of the click. */
  menuActions?: (paneId: string) => readonly PaneMenuAction[];
  /** The color a highlight gets on a plain click, and the ones offered in the picker. */
  highlightColor?: () => string;
  highlightRecents?: () => readonly string[];
  onColorUsed?: (color: string) => void;
  /** The browser took a pane's accelerated renderer away. See `XtermController`. */
  onRendererLost?: (paneId: string) => void;
  /** The renderer that decides a pane's cell has arrived, so it can be measured properly. */
  onRendererReady?: (paneId: string) => void;
  /** Somebody asked to find something in a pane. The selection travels with the request. */
  onFind?: (selected: string) => void;
  /** Something worth saying to the person about a pane, briefly. */
  onNotice?: (text: string) => void;
  /** How many matches a pane found, so the bar can say which one is showing. */
  onFindResults?: (results: { resultIndex: number; resultCount: number } | undefined) => void;
  /** Whether a pane should answer a right click. See `shouldOpenMenu` on the controller. */
  shouldOpenMenu?: () => boolean;
}

interface Pane {
  paneId: string;
  sessionId: string;
  streamId: number;
  element: HTMLElement;
  controller: XtermController;
  /** Read the rows on screen for paths right now, rather than when the output settles. */
  scanLinks: () => void;
}

export class PaneHost {
  readonly #opts: PaneHostOptions;
  readonly #panes = new Map<string, Pane>();
  readonly #byStream = new Map<number, string>();
  /** Callbacks waiting for a pane to say something. See `onceOutput`. */
  readonly #awaitingOutput = new Map<string, () => void>();

  constructor(opts: PaneHostOptions) {
    this.#opts = opts;
  }

  get(paneId: string): Pane | undefined {
    return this.#panes.get(paneId);
  }

  /** The pane showing a session, which is how a message about a session finds its terminal. */
  forSession(sessionId: string): Pane | undefined {
    return [...this.#panes.values()].find((p) => p.sessionId === sessionId);
  }

  paneForStream(streamId: number): Pane | undefined {
    const paneId = this.#byStream.get(streamId);
    return paneId ? this.#panes.get(paneId) : undefined;
  }

  get all(): Pane[] {
    return [...this.#panes.values()];
  }

  /** Element for a pane, created on first request and reused thereafter. */
  element(paneId: string, sessionId: string): HTMLElement {
    const existing = this.#panes.get(paneId);
    if (existing) return existing.element;

    const element = document.createElement('div');
    element.className = 'pane-terminal';

    const controller = new XtermController({
      container: element,
      onData: (data) => this.#opts.onData(paneId, data),
      onResize: (cols, rows) => this.#opts.onResize(paneId, cols, rows),
      onClear: () => this.#opts.onClear?.(paneId),
      menuActions: () => this.#opts.menuActions?.(paneId) ?? [],
      onHighlightsChanged: (highlights) => {
        // Keyed by the session rather than the pane: a highlight belongs to the output it is
        // drawn on, and that output moves with the session when a pane adopts a different one.
        const pane = this.#panes.get(paneId);
        if (pane) void saveHighlights(pane.sessionId, highlights);
      },
      highlightColor: () => this.#opts.highlightColor?.() ?? DEFAULT_COLOR.highlight,
      highlightRecents: () => this.#opts.highlightRecents?.() ?? [],
      onColorUsed: (color) => this.#opts.onColorUsed?.(color),
      onRendererLost: () => this.#opts.onRendererLost?.(paneId),
      onRendererReady: () => this.#opts.onRendererReady?.(paneId),
      onFind: (selected) => this.#opts.onFind?.(selected),
      onNotice: (text) => this.#opts.onNotice?.(text),
      onFindResults: (results) => this.#opts.onFindResults?.(results),
      shouldOpenMenu: () => this.#opts.shouldOpenMenu?.() !== false,
    });

    /**
     * Ask about the paths on screen as they are printed, rather than when one is hovered.
     *
     * xterm caches what a link provider answered for a line and only asks again when the
     * pointer moves to a different line. The first hover therefore arrived before the daemon
     * had confirmed anything, was told there were no links, and that answer stuck: the path
     * stayed inert until the pointer left the line and came back. Resolving as output arrives
     * means the answer is already there by the time anybody hovers.
     *
     * Debounced and limited to the rows actually on screen, so a noisy build does not turn into
     * a request per line.
     */
    let scanTimer = 0;
    let lastScanAt = 0;
    const scanVisible = (): void => {
      clearTimeout(scanTimer);
      scanTimer = 0;
      lastScanAt = Date.now();
      const buffer = controller.term.buffer.active;
      const first = buffer.viewportY;
      const last = Math.min(buffer.length, first + controller.term.rows);
      const found = new Set<string>();
      for (let y = first; y < last; y++) {
        const text = buffer.getLine(y)?.translateToString(true) ?? '';
        if (text === '') continue;
        for (const candidate of findCandidates(text)) found.add(candidate.text);
      }
      const unknown = [...found].filter((c) => this.#opts.lookupPath(c) === undefined);
      if (unknown.length > 0) this.#opts.resolvePaths(paneId, unknown);
    };
    controller.term.onRender(() => {
      /*
       * A maximum wait, not only a settle.
       *
       * An agent redrawing its own screen renders continuously, so waiting for quiet meant waiting
       * forever: the scan was starved for as long as the agent kept working, and a path it had
       * just printed stayed inert the whole time. See `link-scan.ts`.
       */
      if (scanIsOverdue(Date.now(), lastScanAt)) {
        scanVisible();
        return;
      }
      clearTimeout(scanTimer);
      scanTimer = window.setTimeout(scanVisible, QUIET_MS);
    });

    controller.installMarkers(element);

    // What was highlighted last time this session was looked at. Anchored to the text rather
    // than to a row, so it lands correctly even though the buffer was rebuilt from a snapshot.
    void loadHighlights(sessionId).then((saved) => {
      if (saved.length > 0) controller.restoreHighlights(saved);
    });

    controller.registerLinkProvider(
      createPathLinkProvider(controller.term, {
        resolve: (candidates) => this.#opts.resolvePaths(paneId, candidates),
        lookup: this.#opts.lookupPath,
        activate: (resolved, event) => this.#opts.openPath(paneId, resolved, event),
        openUrl: this.#opts.openUrl,
        modifierHeld: this.#opts.modifierHeld,
      }),
    );

    this.#panes.set(paneId, {
      paneId,
      sessionId,
      streamId: 0,
      element,
      controller,
      scanLinks: scanVisible,
    });
    return element;
  }

  bindStream(paneId: string, sessionId: string, streamId: number): void {
    const pane = this.#panes.get(paneId);
    if (!pane) return;
    this.#byStream.delete(pane.streamId);
    pane.streamId = streamId;
    pane.sessionId = sessionId;
    this.#byStream.set(streamId, paneId);
  }

  write(streamId: number, data: Uint8Array, ack: (bytes: number) => void): void {
    const pane = this.paneForStream(streamId);
    pane?.controller.write(data, ack);
    if (pane && data.length > 0) {
      this.#sawOutput(pane.paneId);
      const waiting = this.#awaitingOutput.get(pane.paneId);
      if (waiting) {
        this.#awaitingOutput.delete(pane.paneId);
        waiting();
      }
    }
  }

  /**
   * Call back the first time this pane says anything, or after the wait runs out.
   *
   * Used after an image is pasted: a pane that has printed something has acted on the key, which
   * is the nearest thing to being told the clipboard has been read. Reading a clipboard leaves no
   * trace, so there is nothing better to wait for, and the timeout is there because a program that
   * says nothing at all must not leave the clipboard replaced for good.
   */
  onceOutput(paneId: string, timeoutMs: number, done: () => void): void {
    let finished = false;
    const once = (): void => {
      if (finished) return;
      finished = true;
      this.#awaitingOutput.delete(paneId);
      done();
    };
    this.#awaitingOutput.set(paneId, once);
    setTimeout(once, timeoutMs);
  }

  /**
   * Wait until a pane's shell has actually printed something and then gone quiet.
   *
   * A template used to type its commands the moment the panes existed, which is before any
   * shell has drawn a prompt. The text landed above the prompt rather than at it, so it was
   * mangled on screen and belonged to nothing: pressing Return did not run it, because the
   * shell had never received it as input.
   *
   * A prompt is the first thing a shell prints, so the first output is the signal. The settle
   * afterwards is for a prompt that arrives in more than one write, which a themed one always
   * does.
   */
  whenSettled(paneId: string, fn: () => void): void {
    const existing = this.#waiting.get(paneId);
    if (existing) clearTimeout(existing.timer);
    this.#waiting.set(paneId, { fn, timer: 0, seen: existing?.seen ?? false });
    if (this.#waiting.get(paneId)?.seen === true) this.#sawOutput(paneId);
  }

  readonly #waiting = new Map<string, { fn: () => void; timer: number; seen: boolean }>();

  #sawOutput(paneId: string): void {
    const entry = this.#waiting.get(paneId);
    if (!entry) {
      // Remembered, so a pane that printed before anybody asked still counts as having printed.
      this.#waiting.set(paneId, { fn: () => {}, timer: 0, seen: true });
      return;
    }
    entry.seen = true;
    clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      this.#waiting.delete(paneId);
      entry.fn();
    }, 250);
  }

  /** Replace a pane's contents with a snapshot from the daemon. */
  /**
   * Put a saved screen back, **at the width it was saved at**.
   *
   * A serialized screen is a picture with a width. Written into a terminal of a different width
   * it does not merely look shifted: every line wraps somewhere else and every absolute cursor
   * move lands in the wrong column, so a full-screen application comes back as fragments of
   * several different moments overlapping. That is what an agent looked like after a refresh.
   *
   * The pane is then measured and reflowed to its real size by the caller, which is the same
   * thing that happens when a window is dragged, and which the application is told about so it
   * can repaint.
   */
  restore(
    paneId: string,
    screen: string,
    cols?: number,
    rows?: number,
    onParsed?: () => void,
  ): void {
    const pane = this.#panes.get(paneId);
    if (!pane) return;
    pane.controller.reset();
    if (
      cols &&
      rows &&
      (cols !== pane.controller.term.cols || rows !== pane.controller.term.rows)
    ) {
      pane.controller.term.resize(cols, rows);
    }
    pane.controller.write(new TextEncoder().encode(screen), () => {
      /* a snapshot is not acked: it never came off the credit window */
      /**
       * The callback fires once xterm has actually parsed the bytes, which is the first moment
       * anything can be asked about the screen. Deciding what a tab is before this reads an
       * empty terminal and answers "nothing here", whatever was in the snapshot.
       */
      onParsed?.();
    });
  }

  fit(paneId: string): { cols: number; rows: number } | null {
    return this.#panes.get(paneId)?.controller.fit() ?? null;
  }

  focus(paneId: string): void {
    this.#panes.get(paneId)?.controller.focus();
  }

  /** Stop every pane listening, for when another surface has taken the keyboard. */
  blurAll(): void {
    for (const pane of this.#panes.values()) pane.controller.blur();
  }

  refreshLinks(): void {
    for (const pane of this.#panes.values()) pane.controller.refreshLinks();
  }

  /**
   * Read every pane's visible rows for paths at once.
   *
   * Called the moment Command goes down, which is the one thing that always happens before a link
   * is hovered. It closes the gap the settle leaves: a path printed a moment ago is confirmed
   * while the hand is still moving toward it, rather than on a second pass over the same line.
   */
  scanForLinks(): void {
    for (const pane of this.#panes.values()) pane.scanLinks();
  }

  /** Release every renderer, for a tab that has been hidden long enough to stop paying for one. */
  releaseRenderers(): void {
    for (const pane of this.#panes.values()) pane.controller.releaseRenderer();
  }

  restoreRenderers(): void {
    for (const pane of this.#panes.values()) pane.controller.restoreRenderer();
  }

  get renderersAttached(): number {
    return [...this.#panes.values()].filter((p) => p.controller.rendererAttached).length;
  }

  setScrollback(lines: number): void {
    for (const pane of this.#panes.values()) pane.controller.setScrollback(lines);
  }

  /** Dispose panes that are no longer in the layout, so their renderers are released. */
  retain(paneIds: Iterable<string>): void {
    const keep = new Set(paneIds);
    for (const [paneId, pane] of this.#panes) {
      if (keep.has(paneId)) continue;
      this.#byStream.delete(pane.streamId);
      pane.controller.dispose();
      pane.element.remove();
      this.#panes.delete(paneId);
    }
  }

  disposeAll(): void {
    this.retain([]);
  }
}
