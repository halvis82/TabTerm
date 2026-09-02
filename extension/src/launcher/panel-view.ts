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
  /**
   * Is this command still on screen in the terminal behind the panel?
   *
   * Asked rather than assumed, because scrollback is finite: a command from this morning is in
   * the history list long after its output has fallen off the end of the buffer, and offering
   * to scroll to something that is not there is offering a button that cannot work.
   */
  canScrollTo: (command: string) => boolean;
  onScrollTo: (command: string) => void;
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
    this.#watchSize();

    /**
     * There is no separate minimized form, deliberately.
     *
     * Minimizing used to leave a small puck floating where the panel had been, next to the
     * command button that is permanently in the top right and does the same thing. Two controls
     * for one action, one of them in a place that moves. Minimizing now simply hides the panel,
     * and the button that was always there brings it back where it was.
     */
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
    this.#opts.onClose();
  }

  minimize(): void {
    this.#placement.minimized = true;
    this.#el.hidden = true;
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
    // Going somewhere else is leaving the form. Keeping it open behind another tab meant coming
    // back to a half-typed edit nobody remembered starting.
    this.#editing = null;
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

  /**
   * Keep the whole panel on screen whenever anything could have moved it off.
   *
   * Clamping only on open and on drag was not enough. The panel is as tall as whatever it is
   * showing, so Actions is short and Settings is tall, and switching to a taller page from a
   * position near the bottom pushed the bottom of it past the edge. Typing in Recent did the
   * same thing by growing the list, and resizing the window did it without the panel changing at
   * all.
   *
   * A `ResizeObserver` covers all three, because every one of them ends as a change in height
   * or in the space available for it.
   */
  #watchSize(): void {
    const observer = new ResizeObserver(() => {
      if (this.isOpen) this.#applyPlacement();
    });
    observer.observe(this.#el);
    window.addEventListener('resize', () => {
      if (this.isOpen) this.#applyPlacement();
    });
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

  /**
   * Something happened in the terminal, so whatever is on screen is now out of date.
   *
   * Only while it is open and only for the pages that show live data. Re-rendering the edit
   * form under somebody's hands, or the settings page, would replace what they were typing.
   */
  refreshLive(): void {
    if (!this.isOpen || this.#editing !== null || this.#showingSettings) return;
    if (this.#placement.tab === 'recent') this.#opts.onSearch(this.#search.value);
    if (this.#placement.tab === 'stats' || this.#placement.tab === 'recent') this.render();
  }

  refreshSettings(): void {
    if (this.#showingSettings && this.isOpen) this.render();
  }

  render(): void {
    for (const button of this.#tabBar.children) {
      button.classList.toggle('on', (button as HTMLElement).dataset['tab'] === this.#placement.tab);
    }

    /**
     * The search box belongs to the lists, and only to the lists.
     *
     * Stats, settings, and the form for editing a favorite have nothing to search: an empty
     * box over them is a control that does nothing, and over the edit form it sat directly
     * above another text box, which is worse than useless.
     */
    const searchable =
      !this.#showingSettings && this.#editing === null && this.#placement.tab !== 'stats';
    this.#search.hidden = !searchable;

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
      /**
       * Filled when this command is already a favorite.
       *
       * Every recent row carried an empty star whether or not the command was already kept, so
       * the control said nothing about the state it was showing and starring something twice
       * looked identical to starring it once. Matched on the command text, which is what a
       * person means by "the same command".
       */
      // Only when its output is still in the buffer. See `canScrollTo`.
      if (this.#opts.canScrollTo(row.entry.command)) {
        const jump = document.createElement('button');
        jump.className = 'cmd-icon cmd-jump';
        jump.title = 'Scroll to where this ran';
        jump.textContent = 'Scroll here';
        jump.addEventListener('click', (e) => {
          e.stopPropagation();
          this.#opts.onScrollTo(row.entry.command);
          this.close();
        });
        el.append(jump);
      }

      const kept = this.#favorites.some((f) => f.body.trim() === row.entry.command.trim());
      const star = document.createElement('button');
      star.className = `cmd-icon cmd-star${kept ? ' on' : ''}`;
      star.title = kept ? 'Already a favorite' : 'Keep as a favorite';
      star.textContent = kept ? '★' : '☆';
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        // Starring something already kept would make a second copy of it, which is never what
        // the click meant.
        if (!kept) this.#opts.onStar(row.entry);
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
    /**
     * Nothing on a page with nothing to select.
     *
     * "Arrows to select" over the stats page is an instruction for something that is not there.
     * The gear stays, because settings are reachable from every page.
     */
    const selectable = !this.#showingSettings && this.#placement.tab !== 'stats' && !this.#editing;
    hints.textContent = selectable ? operationsFor(row).join(' · ') : '';

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
      /**
       * Copying finishes the interaction, the same as pasting does.
       *
       * It used to leave the panel open with no sign anything had happened, so the only way to
       * know the copy had worked was to go and paste it somewhere. A copy that leaves no trace
       * is indistinguishable from a key that did nothing.
       */
      this.#opts.onCopy(text);
      this.#flash('Copied');
      this.close();
      return;
    }
    this.#opts.onPaste(text);
    this.close();
  }

  /**
   * A word, briefly, where the panel was.
   *
   * Long enough to be read and short enough that it is gone before it is in the way. It is
   * removed on a timer rather than on an animation event, because an animation that never runs
   * would otherwise leave it on screen forever.
   */
  #flash(text: string): void {
    document.querySelector('.cmd-flash')?.remove();
    const note = document.createElement('div');
    note.className = 'cmd-flash';
    note.textContent = text;
    note.style.left = `${String(this.#placement.x)}px`;
    note.style.top = `${String(this.#placement.y)}px`;
    this.#opts.root.append(note);
    setTimeout(() => note.remove(), 900);
  }
}
