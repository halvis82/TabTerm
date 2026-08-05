import type { CommandEntry, HistoryScope, MergeableSession, SavedItem } from '@tabterm/shared';

/**
 * The floating command palette: history and saved commands, one keyboard away.
 *
 * Enter PASTES the command into the terminal without running it, and Command+Enter copies it.
 * Nothing here ever executes anything on its own. A palette that runs on Enter would make one
 * mistimed keypress destructive, and the commands most worth recalling are exactly the ones
 * worth reading before running. See docs/05-security.md.
 */

export type PaletteRow =
  | { kind: 'history'; entry: CommandEntry }
  | { kind: 'saved'; item: SavedItem }
  | { kind: 'merge'; session: MergeableSession };

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
  onMerge: (sessionId: string) => void;
  onClose: () => void;
}

export function rowText(row: PaletteRow): string {
  if (row.kind === 'history') return row.entry.command;
  if (row.kind === 'saved') return row.item.body;
  return row.session.cwd;
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
      this.setRows([...this.#saved.map((item) => ({ kind: 'saved' as const, item })), ...rows]);
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
        if (row.kind === 'merge') {
          this.#opts.onMerge(row.session.sessionId);
          this.close();
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
      if (row.kind === 'merge') {
        meta.textContent = row.session.title;
        el.classList.add('is-merge');
      } else if (row.kind === 'saved') {
        meta.textContent = row.item.title;
        el.classList.add('is-saved');
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
        if (row.kind === 'merge') this.#opts.onMerge(row.session.sessionId);
        else this.#opts.onPaste(rowText(row));
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

        el.append(run, dir);
      }

      if (row.kind === 'saved') {
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
