import {
  fillPlaceholders,
  isComplete,
  type CommandEntry,
  type HistoryScope,
  type MergeableSession,
  type SavedItem,
} from '@tabterm/shared';

/**
 * The floating command palette: history and saved commands, one keyboard away.
 *
 * Enter PASTES the command into the terminal without running it, and Command+Enter copies it.
 * Nothing here ever executes anything on its own. A palette that runs on Enter would make one
 * mistimed keypress destructive, and the commands most worth recalling are exactly the ones
 * worth reading before running. See docs/05-security.md.
 */

/**
 * A pane, workspace, or session action.
 *
 * These are here rather than on a control bar because a thirteen-button strip is a worse
 * surface than one searchable list: you cannot remember where a button is, but you can always
 * type what you want. See design principle 9 and docs/06-chrome-integration.md.
 */
export interface PaletteAction {
  id: string;
  title: string;
  /** Shown on the right. The keystroke, when there is one. */
  hint?: string;
  run: () => void;
}

export type PaletteRow =
  | { kind: 'history'; entry: CommandEntry }
  | { kind: 'saved'; item: SavedItem }
  | { kind: 'merge'; session: MergeableSession }
  | { kind: 'action'; action: PaletteAction };

export interface PaletteOptions {
  root: HTMLElement;
  onQuery: (query: string, scope: HistoryScope, offset: number) => void;
  onPaste: (text: string) => void;
  onCopy: (text: string) => void;
  onSave: (text: string) => void;
  /** Deliberately separate from paste. Only ever reached through an explicit action. */
  onRun: (text: string) => void;
  onOpenDir: (path: string) => void;
  onDeleteSaved: (id: string) => void;
  onPinSaved: (id: string, pinned: boolean) => void;
  onUseSaved: (id: string) => void;
  /** Promote a history entry to a saved command, scoped or global. */
  onSaveScoped: (text: string, scopeToProject: boolean) => void;
  onMerge: (sessionId: string) => void;
  onClose: () => void;
}

export function rowText(row: PaletteRow): string {
  if (row.kind === 'history') return row.entry.command;
  if (row.kind === 'saved') return row.item.body;
  if (row.kind === 'action') return row.action.title;
  return row.session.cwd;
}

/**
 * Subsequence match, the same rule the history search uses.
 *
 * `sp` finds "Split right" the way `gco` finds `git checkout`, which is what makes a palette
 * faster than a menu rather than merely different from one.
 */
export function matchesAction(title: string, query: string): boolean {
  if (!query) return true;
  const haystack = title.toLowerCase();
  const needle = query.toLowerCase();
  let at = 0;
  for (const ch of needle) {
    if (ch === ' ') continue;
    at = haystack.indexOf(ch, at);
    if (at === -1) return false;
    at++;
  }
  return true;
}

export class Palette {
  readonly #opts: PaletteOptions;
  readonly #el: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #list: HTMLElement;
  #rows: PaletteRow[] = [];
  #selected = 0;
  #open = false;
  /** Merge mode lists other tabs' terminals instead of commands. */
  #mode: 'commands' | 'merge' = 'commands';
  #scope: HistoryScope = 'global';
  #offset = 0;
  #hasMore = false;
  #applied: readonly string[] = [];
  /** Kept separately, because saved items head the list and history pages in beneath them. */
  #saved: readonly SavedItem[] = [];
  /** Pane and workspace actions, always offered, filtered by the same query as everything else. */
  #actions: readonly PaletteAction[] = [];
  #fill: HTMLElement | null = null;
  readonly #scopeBar: HTMLElement;
  readonly #status: HTMLElement;

  constructor(opts: PaletteOptions) {
    this.#opts = opts;

    this.#el = document.createElement('div');
    this.#el.className = 'palette';
    this.#el.hidden = true;

    this.#input = document.createElement('input');
    this.#input.className = 'palette-input';
    this.#input.type = 'text';
    this.#input.placeholder = 'Search history and saved commands';
    this.#input.spellcheck = false;

    this.#list = document.createElement('div');
    this.#list.className = 'palette-list';

    // Scope is a click, not something to remember the syntax for.
    this.#scopeBar = document.createElement('div');
    this.#scopeBar.className = 'palette-scopes';
    const scopes: { id: HistoryScope; label: string }[] = [
      { id: 'global', label: 'All' },
      { id: 'project', label: 'This project' },
      { id: 'directory', label: 'This folder' },
      { id: 'session', label: 'This session' },
    ];
    for (const { id, label } of scopes) {
      const b = document.createElement('button');
      b.className = `palette-scope${id === this.#scope ? ' on' : ''}`;
      b.dataset['scope'] = id;
      b.textContent = label;
      b.addEventListener('click', () => this.#setScope(id));
      this.#scopeBar.append(b);
    }

    this.#status = document.createElement('div');
    this.#status.className = 'palette-status';
    this.#status.hidden = true;

    const footer = document.createElement('div');
    footer.className = 'palette-footer';
    footer.textContent =
      'Enter pastes · Shift+Enter runs · Command+Enter copies · Command+S saves · Escape closes';

    this.#el.append(this.#input, this.#scopeBar, this.#status, this.#list, footer);
    opts.root.append(this.#el);

    // Keystrokes here belong to the palette, never to the shell underneath.
    this.#input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      this.#onKey(e);
    });
    this.#input.addEventListener('input', () => {
      // A new query starts a new result set, so paging restarts with it.
      this.#offset = 0;
      if (this.#mode === 'commands') this.#opts.onQuery(this.#input.value, this.#scope, 0);
    });
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** Open listing terminals from other tabs, to pull one in beside the focused pane. */
  openMerge(): void {
    this.#mode = 'merge';
    this.#open = true;
    this.#el.hidden = false;
    this.#scopeBar.hidden = true;
    this.#input.value = '';
    this.#input.placeholder = 'Choose a terminal from another tab to merge in';
    this.#selected = 0;
    this.#rows = [];
    this.#renderList();
    this.#input.focus();
  }

  setMergeable(sessions: readonly MergeableSession[]): void {
    if (this.#mode !== 'merge') return;
    this.setRows(sessions.map((session) => ({ kind: 'merge' as const, session })));
  }

  open(): void {
    this.#mode = 'commands';
    this.#input.placeholder = 'Search: project: cwd: exit: duration:> since:';
    this.#open = true;
    this.#el.hidden = false;
    this.#scopeBar.hidden = false;
    this.#input.value = '';
    this.#selected = 0;
    this.#offset = 0;
    this.#opts.onQuery('', this.#scope, 0);
    this.#input.focus();
  }

  #setScope(scope: HistoryScope): void {
    this.#scope = scope;
    this.#offset = 0;
    for (const b of this.#scopeBar.children) {
      b.classList.toggle('on', (b as HTMLElement).dataset['scope'] === scope);
    }
    this.#opts.onQuery(this.#input.value, scope, 0);
  }

  /**
   * A page of results.
   *
   * `offset` decides whether this replaces the list or extends it, so a slow page that arrives
   * after the user has typed again cannot overwrite newer results with older ones.
   */
  setSaved(items: readonly SavedItem[]): void {
    this.#saved = items;
  }

  setActions(actions: readonly PaletteAction[]): void {
    this.#actions = actions;
  }

  /** Actions matching the current query, which is what heads the list. */
  #matchingActions(): PaletteRow[] {
    const query = this.#input.value.trim();
    return this.#actions
      .filter((action) => matchesAction(action.title, query))
      .map((action) => ({ kind: 'action' as const, action }));
  }

  setHistoryPage(page: {
    entries: readonly CommandEntry[];
    offset: number;
    hasMore: boolean;
    appliedFilters: readonly string[];
  }): void {
    if (this.#mode !== 'commands') return;
    this.#hasMore = page.hasMore;
    this.#applied = page.appliedFilters;
    const rows = page.entries.map((entry) => ({ kind: 'history' as const, entry }));
    if (page.offset === 0) {
      this.#offset = page.entries.length;
      // Actions first: they are the only rows that do something rather than being text, and a
      // palette that buries them under history is a search box, not a command palette.
      this.setRows([
        ...this.#matchingActions(),
        ...this.#saved.map((item) => ({ kind: 'saved' as const, item })),
        ...rows,
      ]);
    } else {
      this.#offset = page.offset + page.entries.length;
      this.setRows([...this.#rows, ...rows]);
    }
  }

  /** Ask for the next page. Never automatic on open: the first page is what most searches need. */
  #loadMore(): void {
    if (!this.#hasMore) return;
    this.#opts.onQuery(this.#input.value, this.#scope, this.#offset);
  }

  close(): void {
    this.#open = false;
    this.#el.hidden = true;
    this.#opts.onClose();
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  setRows(rows: PaletteRow[]): void {
    this.#rows = rows;
    this.#selected = Math.min(this.#selected, Math.max(0, rows.length - 1));
    this.#renderList();
  }

  #onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.close();
        return;
      case 'ArrowDown':
        e.preventDefault();
        this.#move(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        this.#move(-1);
        return;
      case 'Enter': {
        e.preventDefault();
        const row = this.#rows[this.#selected];
        if (!row) return;
        if (row.kind === 'action') {
          this.close();
          row.action.run();
          return;
        }
        if (row.kind === 'merge') {
          this.#opts.onMerge(row.session.sessionId);
          this.close();
          return;
        }
        if (row.kind === 'saved' && (row.item.placeholders ?? []).length && !e.metaKey) {
          this.#opts.onUseSaved(row.item.id);
          const run = e.shiftKey;
          this.#promptPlaceholders(row.item, (filled) => {
            if (run) this.#opts.onRun(filled);
            else this.#opts.onPaste(filled);
            this.close();
          });
          return;
        }
        const text = rowText(row);
        // Running takes a distinct, deliberate gesture. Pasting is the default because the
        // commands most worth recalling are the ones worth reading first.
        if (e.metaKey) this.#opts.onCopy(text);
        else if (e.shiftKey) this.#opts.onRun(text);
        else this.#opts.onPaste(text);
        this.close();
        return;
      }
      default:
        break;
    }

    // Command+S saves whatever is selected, so a good command found in history is one
    // keystroke away from being kept.
    if (e.metaKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const row = this.#rows[this.#selected];
      if (row) this.#opts.onSave(rowText(row));
    }
  }

  /**
   * Ask for placeholder values before a saved command goes anywhere.
   *
   * Filling happens here rather than at the prompt because a half-substituted command sitting
   * in a terminal is easy to run by accident. Nothing leaves this until every name has a value
   * or a default.
   */
  #promptPlaceholders(item: SavedItem, then: (text: string) => void): void {
    const names = item.placeholders ?? [];
    if (names.length === 0) {
      then(item.body);
      return;
    }

    const box = document.createElement('div');
    box.className = 'palette-fill';
    const heading = document.createElement('div');
    heading.className = 'palette-fill-title';
    heading.textContent = item.title;
    const preview = document.createElement('pre');
    preview.className = 'palette-fill-preview';
    preview.textContent = item.body;
    box.append(heading, preview);

    const values: Record<string, string> = {};
    const inputs: HTMLInputElement[] = [];
    const update = () => {
      preview.textContent = fillPlaceholders(item.body, values);
      go.disabled = !isComplete(item.body, values);
    };

    for (const name of names) {
      const row = document.createElement('label');
      row.className = 'palette-fill-row';
      const label = document.createElement('span');
      label.textContent = name;
      const input = document.createElement('input');
      input.className = 'palette-fill-input';
      input.type = 'text';
      input.placeholder = name;
      input.addEventListener('input', () => {
        values[name] = input.value;
        update();
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') this.#closeFill();
        if (e.key === 'Enter' && !go.disabled) go.click();
      });
      row.append(label, input);
      box.append(row);
      inputs.push(input);
    }

    const actions = document.createElement('div');
    actions.className = 'palette-buttons';
    const go = document.createElement('button');
    go.className = 'palette-action';
    go.textContent = 'Place at the prompt';
    go.addEventListener('click', () => {
      const text = fillPlaceholders(item.body, values);
      this.#closeFill();
      then(text);
    });
    const cancel = document.createElement('button');
    cancel.className = 'palette-action';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.#closeFill());
    actions.append(go, cancel);
    box.append(actions);

    update();
    this.#closeFill();
    this.#el.append(box);
    this.#fill = box;
    inputs[0]?.focus();
  }

  #closeFill(): void {
    this.#fill?.remove();
    this.#fill = null;
  }

  #renderStatus(): void {
    const bits: string[] = [];
    if (this.#applied.length) bits.push(this.#applied.join(' · '));
    this.#status.textContent = bits.join(' — ');
    this.#status.hidden = bits.length === 0;
  }

  #move(delta: number): void {
    if (this.#rows.length === 0) return;
    this.#selected = (this.#selected + delta + this.#rows.length) % this.#rows.length;
    this.#renderList();
    this.#list.children[this.#selected]?.scrollIntoView({ block: 'nearest' });
  }

  #renderList(): void {
    this.#renderStatus();
    if (this.#rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent =
        this.#mode === 'merge'
          ? 'No terminals in other tabs to merge.'
          : 'Nothing yet. History fills in as you run commands, once shell integration is enabled.';
      this.#list.replaceChildren(empty);
      return;
    }

    const elements = this.#rows.map((row, i) => {
      const el = document.createElement('div');
      el.className = `palette-row${i === this.#selected ? ' selected' : ''}`;

      const text = document.createElement('span');
      text.className = 'palette-command';
      text.textContent = rowText(row);
      el.append(text);

      const meta = document.createElement('span');
      meta.className = 'palette-meta';
      if (row.kind === 'action') {
        meta.textContent = row.action.hint ?? '';
        el.classList.add('is-action');
      } else if (row.kind === 'merge') {
        meta.textContent = row.session.title;
        el.classList.add('is-merge');
      } else if (row.kind === 'saved') {
        // The kind, the scope, and how much is still to fill. All three change what clicking
        // it will do, so none of them belong hidden behind a hover.
        const bits: string[] = [row.item.kind];
        if (row.item.gitRoot) bits.push('project');
        const toFill = (row.item.placeholders ?? []).length;
        if (toFill) bits.push(`${String(toFill)} to fill`);
        meta.textContent = `${row.item.title} · ${bits.join(' · ')}`;
        el.classList.add('is-saved');
        if (row.item.pinned) el.classList.add('pinned');
      } else {
        const bits: string[] = [];
        if (row.entry.exitCode !== undefined && row.entry.exitCode !== 0) {
          bits.push(`exit ${String(row.entry.exitCode)}`);
          el.classList.add('failed');
        }
        if (row.entry.useCount > 1) bits.push(`×${String(row.entry.useCount)}`);
        meta.textContent = bits.join(' · ');
      }
      el.append(meta);

      // Clicking the row pastes. Running and opening are separate buttons, so neither can
      // happen by aiming badly. See docs/05-security.md.
      el.addEventListener('click', () => {
        this.#selected = i;
        // An action row is the one kind that does something rather than being text, so it runs
        // on a click. Everything else stages or pastes.
        if (row.kind === 'action') {
          this.close();
          row.action.run();
          return;
        }
        if (row.kind === 'merge') {
          this.#opts.onMerge(row.session.sessionId);
          this.close();
          return;
        }
        // A saved item with placeholders asks for values first. A half-substituted command
        // sitting at a prompt is too easy to run by accident.
        if (row.kind === 'saved') {
          this.#opts.onUseSaved(row.item.id);
          this.#promptPlaceholders(row.item, (text) => {
            this.#opts.onPaste(text);
            this.close();
          });
          return;
        }
        this.#opts.onPaste(rowText(row));
        this.close();
      });

      if (row.kind === 'history') {
        const run = document.createElement('button');
        run.className = 'palette-action';
        run.textContent = 'Run';
        run.title = 'Run this command now';
        run.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.#opts.onRun(row.entry.command);
          this.close();
        });

        const dir = document.createElement('button');
        dir.className = 'palette-action';
        dir.textContent = 'Folder';
        dir.title = row.entry.cwd;
        dir.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.#opts.onOpenDir(row.entry.cwd);
          this.close();
        });

        const save = document.createElement('button');
        save.className = 'palette-action';
        save.textContent = 'Save';
        save.title = 'Keep this command. Hold Option to scope it to this project.';
        save.addEventListener('click', (ev) => {
          ev.stopPropagation();
          // Option scopes it to the project. A modifier rather than a second button, because
          // the common case is global and a row of buttons gets noisy fast.
          this.#opts.onSaveScoped(row.entry.command, ev.altKey);
          this.close();
        });

        el.append(run, dir, save);
      }

      if (row.kind === 'saved') {
        const pin = document.createElement('button');
        pin.className = `palette-action${row.item.pinned ? ' on' : ''}`;
        pin.textContent = row.item.pinned ? '★' : '☆';
        pin.title = row.item.pinned ? 'Unpin' : 'Pin';
        pin.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.#opts.onPinSaved(row.item.id, !row.item.pinned);
        });
        el.append(pin);

        const del = document.createElement('button');
        del.className = 'palette-delete';
        del.textContent = '×';
        del.title = 'Delete saved command';
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.#opts.onDeleteSaved(row.item.id);
        });
        el.append(del);
      }

      return el;
    });

    // Paging is a deliberate click rather than an infinite scroll: a history search that keeps
    // growing as you look at it is harder to read, not easier.
    if (this.#hasMore && this.#mode === 'commands') {
      const more = document.createElement('button');
      more.className = 'palette-more';
      more.textContent = 'Load more';
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.#loadMore();
      });
      elements.push(more as unknown as HTMLDivElement);
    }

    this.#list.replaceChildren(...elements);
  }
}
