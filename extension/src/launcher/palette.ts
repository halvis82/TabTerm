import type { CommandEntry, MergeableSession, SavedItem } from '@tabterm/shared';

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
  onQuery: (query: string) => void;
  onPaste: (text: string) => void;
  onCopy: (text: string) => void;
  onSave: (text: string) => void;
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

    const footer = document.createElement('div');
    footer.className = 'palette-footer';
    footer.textContent = 'Enter pastes · Command+Enter copies · Command+S saves · Escape closes';

    this.#el.append(this.#input, this.#list, footer);
    opts.root.append(this.#el);

    // Keystrokes here belong to the palette, never to the shell underneath.
    this.#input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      this.#onKey(e);
    });
    this.#input.addEventListener('input', () => {
      if (this.#mode === 'commands') this.#opts.onQuery(this.#input.value);
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
    this.#input.placeholder = 'Search history and saved commands';
    this.#open = true;
    this.#el.hidden = false;
    this.#input.value = '';
    this.#selected = 0;
    this.#opts.onQuery('');
    this.#input.focus();
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
        if (e.metaKey) this.#opts.onCopy(text);
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

  #move(delta: number): void {
    if (this.#rows.length === 0) return;
    this.#selected = (this.#selected + delta + this.#rows.length) % this.#rows.length;
    this.#renderList();
    this.#list.children[this.#selected]?.scrollIntoView({ block: 'nearest' });
  }

  #renderList(): void {
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

    this.#list.replaceChildren(
      ...this.#rows.map((row, i) => {
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

        el.addEventListener('click', () => {
          this.#selected = i;
          if (row.kind === 'merge') this.#opts.onMerge(row.session.sessionId);
          else this.#opts.onPaste(rowText(row));
          this.close();
        });

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
      }),
    );
  }
}
