import type { LauncherState, RecentDir } from '@tabterm/shared';

/**
 * The panel a fresh terminal tab opens with.
 *
 * It sits over a live shell rather than replacing it. The shell is already running in the home
 * directory and already has focus, so someone who wants to type just types and the panel gets
 * out of the way on the first keystroke. Nobody has to dismiss anything to start working.
 *
 * A section with nothing in it is not rendered at all, so an empty plugin list shows no plugin
 * heading rather than an empty one.
 */

export interface LauncherOptions {
  root: HTMLElement;
  onChooseDir: (path: string) => void;
  onCreateLayout: (path: string, panes: number, direction: 'horizontal' | 'vertical') => void;
  onPinDir: (path: string, pinned: boolean) => void;
  onForgetDir: (path: string) => void;
  onDismiss: () => void;
}

export class Launcher {
  readonly #opts: LauncherOptions;
  readonly #el: HTMLElement;
  #state: LauncherState | null = null;
  #dismissed = false;

  constructor(opts: LauncherOptions) {
    this.#opts = opts;
    this.#el = document.createElement('div');
    this.#el.className = 'launcher';
    this.#el.hidden = true;
    opts.root.append(this.#el);
  }

  get dismissed(): boolean {
    return this.#dismissed;
  }

  setState(state: LauncherState): void {
    this.#state = state;
    if (!this.#dismissed) this.render();
  }

  /**
   * Called as soon as anything is sent to the shell.
   *
   * The panel never comes back on its own: once you have started working, having a panel
   * reappear over your terminal would be worse than never having shown it.
   */
  dismiss(): void {
    if (this.#dismissed) return;
    this.#dismissed = true;
    this.#el.hidden = true;
    this.#el.replaceChildren();
    this.#opts.onDismiss();
  }

  render(): void {
    if (this.#dismissed || !this.#state) return;
    const state = this.#state;

    const sections: HTMLElement[] = [];

    // --- new layout in a directory ---------------------------------------
    sections.push(this.#layoutSection(state));

    // --- recent directories ----------------------------------------------
    if (state.recentDirs.length > 0) {
      sections.push(
        section(
          'Recent folders',
          state.recentDirs.map((d) => this.#dirRow(d, state.home)),
        ),
      );
    }

    // --- plugins ----------------------------------------------------------
    // Rendered only when there is something to render. An empty heading is noise.
    if (state.plugins.length > 0) {
      sections.push(
        section(
          'Plugins',
          state.plugins.map((p) => {
            const row = document.createElement('button');
            row.className = 'launcher-row';
            row.append(strong(p.title), dim(p.description ?? ''));
            return row;
          }),
        ),
      );
    }

    const hint = document.createElement('div');
    hint.className = 'launcher-hint';
    hint.textContent = 'Start typing to use the shell. Command+K for history and saved commands.';

    this.#el.replaceChildren(...sections, hint);
    this.#el.hidden = false;
  }

  #layoutSection(state: LauncherState): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'launcher-section';
    wrap.append(heading('Open a folder'));

    const form = document.createElement('div');
    form.className = 'launcher-form';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'launcher-input';
    input.placeholder = '~/Projects/something';
    input.spellcheck = false;
    // Typing a path here must not reach the shell underneath.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const path = input.value.trim();
        if (path) this.#opts.onChooseDir(path);
      }
      if (e.key === 'Escape') this.dismiss();
    });

    const buttons = document.createElement('div');
    buttons.className = 'launcher-buttons';

    const presets: { label: string; panes: number; dir: 'horizontal' | 'vertical' }[] = [
      { label: 'Open', panes: 1, dir: 'horizontal' },
      { label: 'Split in 2', panes: 2, dir: 'horizontal' },
      { label: '3 panes', panes: 3, dir: 'horizontal' },
      { label: '3 stacked', panes: 3, dir: 'vertical' },
    ];
    for (const preset of presets) {
      const b = document.createElement('button');
      b.className = 'launcher-chip';
      b.textContent = preset.label;
      b.addEventListener('click', () => {
        const path = input.value.trim() || state.home;
        if (preset.panes === 1) this.#opts.onChooseDir(path);
        else this.#opts.onCreateLayout(path, preset.panes, preset.dir);
      });
      buttons.append(b);
    }

    const note = document.createElement('div');
    note.className = 'launcher-note';
    note.textContent = 'The folder is created if it does not exist.';

    form.append(input, buttons);
    wrap.append(form, note);
    return wrap;
  }

  #dirRow(dir: RecentDir, home: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'launcher-row-wrap';

    const main = document.createElement('button');
    main.className = 'launcher-row';
    main.append(strong(dir.name), dim(shorten(dir.path, home)));
    main.addEventListener('click', () => this.#opts.onChooseDir(dir.path));

    const pin = document.createElement('button');
    pin.className = `launcher-icon${dir.pinned ? ' on' : ''}`;
    pin.title = dir.pinned ? 'Unpin' : 'Pin';
    pin.textContent = dir.pinned ? '★' : '☆';
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#opts.onPinDir(dir.path, !dir.pinned);
    });

    const forget = document.createElement('button');
    forget.className = 'launcher-icon';
    forget.title = 'Forget';
    forget.textContent = '×';
    forget.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#opts.onForgetDir(dir.path);
    });

    row.append(main, pin, forget);
    return row;
  }
}

// --- small DOM helpers -------------------------------------------------

function heading(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.className = 'launcher-heading';
  h.textContent = text;
  return h;
}

function section(title: string, rows: HTMLElement[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'launcher-section';
  wrap.append(heading(title), ...rows);
  return wrap;
}

function strong(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'launcher-strong';
  el.textContent = text;
  return el;
}

function dim(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'launcher-dim';
  el.textContent = text;
  return el;
}

export function shorten(path: string, home: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
