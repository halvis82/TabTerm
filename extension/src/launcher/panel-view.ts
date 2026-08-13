import type { CommandEntry, SavedItem } from '@tabterm/shared';
import {
  DEFAULT_PLACEMENT,
  clampPlacement,
  matches,
  operationsFor,
  rowLabel,
  rowText,
  type PanelAction,
  type PanelPlacement,
  type PanelRow,
  type PanelTab,
} from './command-panel.js';

/**
 * The command panel's DOM.
 *
 * Layout and behavior only; every decision worth arguing about lives in `command-panel.ts` and
 * is tested there. See docs/14-command-menu.md.
 */

export interface PanelOptions {
  root: HTMLElement;
  onPaste: (text: string) => void;
  onCopy: (text: string) => void;
  onSearch: (query: string) => void;
  onKeep: (text: string) => void;
  onStar: (entry: CommandEntry) => void;
  onEdit: (
    id: string,
    changes: { title?: string; body?: string; hotstring?: string | null },
  ) => void;
  onDelete: (id: string) => void;
  onCreate: (fields: { title: string; body: string; hotstring: string }) => void;
  onClose: () => void;
  onOpen: () => void;
  onPlacement: (placement: PanelPlacement) => void;
  actions: () => PanelAction[];
  settings: () => HTMLElement;
  stats: () => HTMLElement;
}

const PANEL_WIDTH = 460;

export class CommandPanel {
  readonly #opts: PanelOptions;
  readonly #el: HTMLElement;
  readonly #puck: HTMLElement;
  readonly #search: HTMLInputElement;
  readonly #list: HTMLElement;
  readonly #footer: HTMLElement;
  readonly #tabBar: HTMLElement;
  readonly #body: HTMLElement;

  #favorites: readonly SavedItem[] = [];
  #recent: readonly CommandEntry[] = [];
  #rows: PanelRow[] = [];
  #selected = 0;
  #open = false;
  #placement: PanelPlacement = { ...DEFAULT_PLACEMENT };
  #editing: string | null = null;
  #showingSettings = false;

  constructor(opts: PanelOptions) {
    this.#opts = opts;

    this.#el = document.createElement('div');
    this.#el.className = 'cmd-panel';
    this.#el.hidden = true;

    // A drag handle that is also the tab bar: the panel is small, and a title bar that exists
    // only to be grabbed would cost a row of space for nothing.
    const header = document.createElement('div');
    header.className = 'cmd-header';

    this.#tabBar = document.createElement('div');
    this.#tabBar.className = 'cmd-tabs';
    for (const [tab, label] of [
      ['favorites', 'Favorites'],
      ['recent', 'Recent'],
      ['actions', 'Actions'],
      ['stats', 'Stats'],
    ] as [PanelTab, string][]) {
      const button = document.createElement('button');
      button.className = 'cmd-tab';
      button.dataset['tab'] = tab;
      button.textContent = label;
      button.addEventListener('click', () => this.#setTab(tab));
      this.#tabBar.append(button);
    }

    const minimize = document.createElement('button');
    minimize.className = 'cmd-icon';
    minimize.title = 'Minimize';
    minimize.textContent = '—';
    minimize.addEventListener('click', () => this.minimize());

    header.append(this.#tabBar, minimize);
    this.#wireDrag(header);

    this.#search = document.createElement('input');
    this.#search.className = 'cmd-search';
    this.#search.type = 'text';
    this.#search.placeholder = 'Search';
    this.#search.spellcheck = false;
    this.#search.addEventListener('input', () => {
      this.#selected = 0;
      this.#opts.onSearch(this.#search.value);
      this.render();
    });

    this.#list = document.createElement('div');
    this.#list.className = 'cmd-list';

    this.#body = document.createElement('div');
    this.#body.className = 'cmd-body';
    this.#body.append(this.#list);

    this.#footer = document.createElement('div');
    this.#footer.className = 'cmd-footer';

    // The panel owns the keyboard while it is open, so the handler is on the panel rather than
    // only on the search box. Otherwise a click on a row left focus somewhere with no key
    // handling at all, and Escape went to the terminal underneath instead of closing this.
    this.#el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      this.#onKey(e);
    });

    this.#el.append(header, this.#search, this.#body, this.#footer);
    opts.root.append(this.#el);

    // The minimized form: a small puck that reopens where it was.
    this.#puck = document.createElement('button');
    this.#puck.className = 'cmd-puck';
    this.#puck.hidden = true;
    this.#puck.title = 'Commands';
    this.#puck.textContent = '⌘';
    this.#puck.addEventListener('click', () => this.restore());
    opts.root.append(this.#puck);
  }

  get isOpen(): boolean {
    return this.#open && !this.#placement.minimized;
  }

  setPlacement(placement: PanelPlacement): void {
    this.#placement = { ...placement };
    this.#applyPlacement();
  }

  setFavorites(items: readonly SavedItem[]): void {
    this.#favorites = items;
    if (this.#open) this.render();
  }

  setRecent(entries: readonly CommandEntry[]): void {
    this.#recent = entries;
    if (this.#open) this.render();
  }

  /** Open on the last tab. Focus always comes to the panel; see the note below. */
  open(): void {
    this.#open = true;
    this.#placement.minimized = false;
    this.#showingSettings = false;
    this.#editing = null;
    this.#puck.hidden = true;
    this.#el.hidden = false;
    // A fresh query every time. Reopening to find last time's filter still applied is a list
    // that appears empty for a reason nothing on screen explains.
    this.#search.value = '';
    this.#selected = 0;
    this.#applyPlacement();
    this.#opts.onOpen();
    // Ask for history every time it opens, so Recent is current rather than whatever arrived
    // last time the panel happened to be looking.
    this.#opts.onSearch(this.#search.value);
    this.render();
    // Focus always comes here, even when opened by the button: the panel and the terminal can
    // never both be active, and leaving focus on the button meant keystrokes fell through to
    // the shell while a list was plainly on screen waiting to be used.
    this.#search.focus();
    this.#save();
  }

  close(): void {
    this.#open = false;
    this.#el.hidden = true;
    this.#puck.hidden = true;
    this.#opts.onClose();
  }

  minimize(): void {
    this.#placement.minimized = true;
    this.#el.hidden = true;
    this.#puck.hidden = false;
    this.#applyPlacement();
    this.#save();
    this.#opts.onClose();
  }

  restore(): void {
    this.open();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  #setTab(tab: PanelTab): void {
    this.#placement.tab = tab;
    this.#selected = 0;
    this.#showingSettings = false;
    // Recent is fetched, not held: history lives in the daemon and the panel may have been open
    // for a while. Without this the tab was simply empty until you typed something into search.
    if (tab === 'recent') this.#opts.onSearch(this.#search.value);
    this.render();
    this.#save();
    this.#search.focus();
  }

  #save(): void {
    this.#opts.onPlacement({ ...this.#placement });
  }

  #applyPlacement(): void {
    const clamped = clampPlacement(
      this.#placement,
      { width: window.innerWidth, height: window.innerHeight },
      { width: PANEL_WIDTH, height: this.#el.offsetHeight || 420 },
    );
    this.#placement = clamped;
    this.#el.style.left = `${String(clamped.x)}px`;
    this.#el.style.top = `${String(clamped.y)}px`;
    this.#puck.style.left = `${String(clamped.x + PANEL_WIDTH - 44)}px`;
    this.#puck.style.top = `${String(clamped.y)}px`;
  }

  /**
   * Dragging by the header.
   *
   * Applied to the DOM as it happens and saved once on release, so a drag does not write to
   * storage on every pointer move.
   */
  #wireDrag(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (down: PointerEvent) => {
      if ((down.target as HTMLElement).closest('button')) return;
      down.preventDefault();
      handle.setPointerCapture(down.pointerId);
      const startX = down.clientX - this.#placement.x;
      const startY = down.clientY - this.#placement.y;

      const move = (e: PointerEvent) => {
        this.#placement.x = e.clientX - startX;
        this.#placement.y = e.clientY - startY;
        this.#applyPlacement();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.#save();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  #currentRows(): PanelRow[] {
    const query = this.#search.value.trim();
    if (this.#placement.tab === 'actions') {
      return this.#opts
        .actions()
        .filter((a) => matches(a.title, query))
        .map((action) => ({ kind: 'action' as const, action }));
    }
    if (this.#placement.tab === 'favorites') {
      return this.#favorites
        .filter((item) => matches(`${item.title} ${item.body} ${item.hotstring ?? ''}`, query))
        .map((item) => ({ kind: 'favorite' as const, item }));
    }
    return this.#recent
      .filter((entry) => matches(entry.command, query))
      .map((entry) => ({ kind: 'recent' as const, entry }));
  }

  /**
   * Redraw settings, but only if they are what is on screen.
   *
   * The daemon answers a moment after the panel opens, and a switch that appears in the wrong
   * position and then corrects itself reads as the switch having been flipped by something.
   */
  /** Open straight onto settings, for the entry on the toolbar icon. */
  openSettings(): void {
    this.open();
    this.#showingSettings = true;
    this.render();
  }

  refreshSettings(): void {
    if (this.#showingSettings && this.isOpen) this.render();
  }

  render(): void {
    for (const button of this.#tabBar.children) {
      button.classList.toggle('on', (button as HTMLElement).dataset['tab'] === this.#placement.tab);
    }

    if (this.#showingSettings) {
      this.#body.replaceChildren(this.#opts.settings());
      this.#renderFooter(undefined);
      return;
    }
    if (this.#placement.tab === 'stats') {
      // Not a list of rows: nothing here is selectable or pasteable, so it does not pretend to
      // be by rendering as one.
      this.#rows = [];
      this.#body.replaceChildren(this.#opts.stats());
      this.#renderFooter(undefined);
      return;
    }
    if (this.#editing) {
      const item = this.#favorites.find((f) => f.id === this.#editing);
      if (item) {
        this.#body.replaceChildren(this.#editForm(item));
        this.#renderFooter(undefined);
        return;
      }
      this.#editing = null;
    }

    this.#rows = this.#currentRows();
    this.#selected = Math.min(this.#selected, Math.max(0, this.#rows.length - 1));
    this.#body.replaceChildren(this.#list);

    if (this.#rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cmd-empty';
      empty.textContent =
        this.#placement.tab === 'favorites'
          ? 'Nothing kept yet. Star a command in Recent, or add one below.'
          : 'Nothing here yet.';
      const rows: HTMLElement[] = [empty];
      if (this.#placement.tab === 'favorites') rows.push(this.#addButton());
      this.#list.replaceChildren(...rows);
      this.#renderFooter(undefined);
      return;
    }

    const elements = this.#rows.map((row, index) => this.#rowElement(row, index));
    if (this.#placement.tab === 'favorites') elements.push(this.#addButton());
    this.#list.replaceChildren(...elements);
    this.#renderFooter(this.#rows[this.#selected]);
  }

  #addButton(): HTMLElement {
    const add = document.createElement('button');
    add.className = 'cmd-add';
    add.textContent = '+  Add a command';
    add.addEventListener('click', () => {
      this.#opts.onCreate({ title: 'New command', body: '', hotstring: '' });
    });
    return add;
  }

  #rowElement(row: PanelRow, index: number): HTMLElement {
    const el = document.createElement('div');
    el.className = `cmd-row${index === this.#selected ? ' selected' : ''} is-${row.kind}`;

    const label = document.createElement('span');
    label.className = 'cmd-row-label';
    label.textContent = rowLabel(row);
    el.append(label);

    const meta = document.createElement('span');
    meta.className = 'cmd-row-meta';
    if (row.kind === 'action') {
      meta.textContent = row.action.hint ?? '';
    } else if (row.kind === 'favorite') {
      // The command itself is the useful secondary line when the row shows a name instead.
      meta.textContent = row.item.title && row.item.title !== row.item.body ? row.item.body : '';
      if (row.item.hotstring) {
        const badge = document.createElement('span');
        badge.className = 'cmd-hotstring';
        // A visible marker, so an abbreviation is discoverable from the list rather than only
        // from the edit form.
        badge.textContent = `⌁ ${row.item.hotstring}`;
        el.append(badge);
      }
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

    // Selecting and acting are separate. A single click highlights; a double-click acts.
    el.addEventListener('click', () => {
      this.#selected = index;
      this.render();
      this.#search.focus();
    });
    el.addEventListener('dblclick', () => {
      this.#selected = index;
      this.#activate('paste');
    });

    if (row.kind === 'recent') {
      const star = document.createElement('button');
      star.className = 'cmd-icon';
      star.title = 'Keep as a favorite';
      star.textContent = '☆';
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#opts.onStar(row.entry);
      });
      el.append(star);
    }
    if (row.kind === 'favorite') {
      const edit = document.createElement('button');
      edit.className = 'cmd-icon';
      edit.title = 'Edit';
      edit.textContent = '✎';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#editing = row.item.id;
        this.render();
      });
      el.append(edit);
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.#editing = row.item.id;
        this.render();
      });
    }
    return el;
  }

  #renderFooter(row: PanelRow | undefined): void {
    const hints = document.createElement('span');
    hints.className = 'cmd-hints';
    hints.textContent = operationsFor(row).join(' · ');

    const gear = document.createElement('button');
    gear.className = 'cmd-icon cmd-gear';
    gear.title = 'Settings';
    gear.textContent = '⚙';
    gear.addEventListener('click', () => {
      this.#showingSettings = !this.#showingSettings;
      this.render();
    });

    this.#footer.replaceChildren(hints, gear);
  }

  #editForm(item: SavedItem): HTMLElement {
    const form = document.createElement('div');
    form.className = 'cmd-edit';

    const field = (label: string, value: string, placeholder: string) => {
      const wrap = document.createElement('label');
      wrap.className = 'cmd-field';
      const text = document.createElement('span');
      text.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.addEventListener('keydown', (e) => e.stopPropagation());
      wrap.append(text, input);
      form.append(wrap);
      return input;
    };

    const title = field('Name', item.title, 'What the list shows');
    const body = field('Command', item.body, 'What gets pasted');
    const hotstring = field('Hotstring', item.hotstring ?? '', 'Type this, then space, to expand');

    const note = document.createElement('div');
    note.className = 'cmd-note';
    note.textContent = 'A hotstring expands where keystrokes are text, and never inside vim.';
    form.append(note);

    const buttons = document.createElement('div');
    buttons.className = 'cmd-buttons';

    const save = document.createElement('button');
    save.className = 'cmd-button primary';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      this.#opts.onEdit(item.id, {
        title: title.value,
        body: body.value,
        hotstring: hotstring.value.trim() || null,
      });
      this.#editing = null;
      this.render();
    });

    const remove = document.createElement('button');
    remove.className = 'cmd-button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => {
      this.#opts.onDelete(item.id);
      this.#editing = null;
      this.render();
    });

    const cancel = document.createElement('button');
    cancel.className = 'cmd-button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      this.#editing = null;
      this.render();
    });

    buttons.append(save, cancel, remove);
    form.append(buttons);
    return form;
  }

  #move(delta: number): void {
    if (this.#rows.length === 0) return;
    this.#selected = (this.#selected + delta + this.#rows.length) % this.#rows.length;
    this.render();
    this.#list.children[this.#selected]?.scrollIntoView({ block: 'nearest' });
  }

  #onKey(e: KeyboardEvent): void {
    if (this.#editing || this.#showingSettings) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.#editing = null;
        this.#showingSettings = false;
        this.render();
      }
      return;
    }

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
      case 'Enter':
        e.preventDefault();
        this.#activate(e.metaKey ? 'copy' : 'paste');
        return;
      case 'Tab':
        // Cycling tabs from the keyboard, since the panel has three of them and reaching for
        // the mouse to change list is the thing this panel exists to avoid.
        e.preventDefault();
        this.#cycleTab(e.shiftKey ? -1 : 1);
        return;
      default:
        break;
    }

    const row = this.#rows[this.#selected];
    if (e.key.toLowerCase() === 'e' && row?.kind === 'favorite' && !this.#search.value) {
      e.preventDefault();
      this.#editing = row.item.id;
      this.render();
      return;
    }
    if (e.metaKey && e.key.toLowerCase() === 's' && row) {
      e.preventDefault();
      this.#opts.onKeep(rowText(row));
    }
  }

  #cycleTab(delta: number): void {
    const order: PanelTab[] = ['favorites', 'recent', 'actions', 'stats'];
    const at = order.indexOf(this.#placement.tab);
    this.#setTab(order[(at + delta + order.length) % order.length] as PanelTab);
  }

  #activate(how: 'paste' | 'copy'): void {
    const row = this.#rows[this.#selected];
    if (!row) return;
    if (row.kind === 'action') {
      if (how === 'copy') return;
      this.close();
      row.action.run();
      return;
    }
    const text = rowText(row);
    if (how === 'copy') {
      this.#opts.onCopy(text);
      return;
    }
    this.#opts.onPaste(text);
    this.close();
  }
}
