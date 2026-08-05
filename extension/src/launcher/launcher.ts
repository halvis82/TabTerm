import type {
  LauncherState,
  ProjectConfigInfo,
  RecentDir,
  ResumableAgentSession,
} from '@tabterm/shared';

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
  onLaunchAgent: (path: string) => void;
  onChooseDir: (path: string) => void;
  onCreateLayout: (path: string, panes: number, direction: 'horizontal' | 'vertical') => void;
  onPinDir: (path: string, pinned: boolean) => void;
  onForgetDir: (path: string) => void;
  /** Ask the daemon what a directory declares. Answers arrive via projectConfig(). */
  onInspectProject: (path: string) => void;
  onDecideProjectTrust: (info: ProjectConfigInfo, decision: 'trusted' | 'denied') => void;
  onOpenProject: (path: string) => void;
  onResumeAgent: (session: ResumableAgentSession) => void;
  onDismiss: () => void;
}

export class Launcher {
  readonly #opts: LauncherOptions;
  readonly #el: HTMLElement;
  #state: LauncherState | null = null;
  #dismissed = false;
  /** Per directory, what the daemon reported. Absent means not asked or nothing there. */
  readonly #projects = new Map<string, ProjectConfigInfo>();
  #expanded: string | null = null;
  #resumable: readonly ResumableAgentSession[] = [];

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
    const resume = this.#resumeSection(state.home);
    if (resume) sections.push(resume);

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

    const agent = document.createElement('button');
    agent.className = 'launcher-chip agent';
    agent.textContent = 'Open agent here';
    agent.addEventListener('click', () => {
      this.#opts.onLaunchAgent(input.value.trim() || state.home);
    });

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
    buttons.append(agent);

    const note = document.createElement('div');
    note.className = 'launcher-note';
    note.textContent = 'The folder is created if it does not exist.';

    form.append(input, buttons);
    wrap.append(form, note);
    return wrap;
  }

  /** Agent sessions that could be picked back up. Shown, never resumed automatically. */
  setResumable(sessions: readonly ResumableAgentSession[]): void {
    this.#resumable = sessions;
    if (!this.#dismissed) this.render();
  }

  #resumeSection(home: string): HTMLElement | null {
    if (this.#resumable.length === 0) return null;
    const rows = this.#resumable.slice(0, 5).map((session) => {
      const row = document.createElement('button');
      row.className = 'launcher-row';
      row.append(
        strong(session.summary ?? `Session ${session.sessionId.slice(0, 8)}`),
        dim(shorten(session.cwd, home)),
      );
      row.title = session.sessionId;
      row.addEventListener('click', () => this.#opts.onResumeAgent(session));
      return row;
    });
    return section('Resume an agent session', rows);
  }

  /** Record what a directory declares, and show it. */
  projectConfig(cwd: string, config: ProjectConfigInfo | null): void {
    if (config) this.#projects.set(cwd, config);
    else this.#projects.delete(cwd);
    if (!this.#dismissed) this.render();
  }

  /**
   * The approval prompt.
   *
   * It shows every command the file declares, exactly as written, because approving a summary
   * is not approving anything. A changed file says so plainly rather than quietly re-asking:
   * the person needs to know they trusted this once already.
   */
  #projectPanel(dir: RecentDir, info: ProjectConfigInfo): HTMLElement {
    const box = document.createElement('div');
    box.className = 'launcher-project';

    const title = document.createElement('div');
    title.className = 'launcher-project-title';
    title.textContent = info.name;
    box.append(title);

    if (info.changedSince) {
      const warn = document.createElement('div');
      warn.className = 'launcher-project-warn';
      warn.textContent =
        info.changedSince === 'trusted'
          ? 'This file has changed since you approved it. Review it again.'
          : 'This file has changed since you rejected it.';
      box.append(warn);
    }

    const path = document.createElement('div');
    path.className = 'launcher-dim';
    path.textContent = info.path;
    box.append(path);

    const list = document.createElement('ul');
    list.className = 'launcher-project-commands';
    for (const argv of info.commands) {
      const li = document.createElement('li');
      // textContent, never innerHTML: this string came from a cloned repository.
      li.textContent = argv.length ? argv.join(' ') : '(shell)';
      list.append(li);
    }
    if (info.commands.length) box.append(list);

    const buttons = document.createElement('div');
    buttons.className = 'launcher-buttons';

    if (info.action === 'offer') {
      const open = document.createElement('button');
      open.className = 'launcher-chip primary';
      open.textContent = `Open (${String(info.paneCount)} panes)`;
      open.addEventListener('click', () => this.#opts.onOpenProject(dir.path));
      const revoke = document.createElement('button');
      revoke.className = 'launcher-chip';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => this.#opts.onDecideProjectTrust(info, 'denied'));
      buttons.append(open, revoke);
    } else {
      const approve = document.createElement('button');
      approve.className = 'launcher-chip primary';
      approve.textContent = 'Approve and open';
      approve.addEventListener('click', () => {
        this.#opts.onDecideProjectTrust(info, 'trusted');
        this.#opts.onOpenProject(dir.path);
      });
      const reject = document.createElement('button');
      reject.className = 'launcher-chip';
      reject.textContent = 'Never for this project';
      reject.addEventListener('click', () => this.#opts.onDecideProjectTrust(info, 'denied'));
      buttons.append(approve, reject);
    }

    box.append(buttons);
    return box;
  }

  #dirRow(dir: RecentDir, home: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'launcher-row-wrap';

    const main = document.createElement('button');
    main.className = 'launcher-row';
    main.append(strong(dir.name), dim(shorten(dir.path, home)));
    // Only when the directory is somewhere *inside* a repository. Repeating the name on the
    // root itself would say the same thing twice.
    if (dir.project && dir.project.root !== dir.path) {
      const badge = document.createElement('span');
      badge.className = 'launcher-badge';
      badge.textContent = dir.project.name;
      badge.title = dir.project.root;
      main.append(badge);
    }
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

    // Ask about each listed directory once. Bounded by what is on screen, so this is a handful
    // of stat calls on tab open rather than a scan.
    if (!this.#projects.has(dir.path)) this.#opts.onInspectProject(dir.path);

    const info = this.#projects.get(dir.path);
    if (!info || info.action === 'ignore') return row;

    const chip = document.createElement('button');
    chip.className = `launcher-chip project${info.action === 'ask' ? ' unreviewed' : ''}`;
    chip.textContent = info.action === 'offer' ? 'Project layout' : 'Project layout (review)';
    chip.title = info.path;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#expanded = this.#expanded === dir.path ? null : dir.path;
      this.render();
    });
    row.insertBefore(chip, pin);

    if (this.#expanded !== dir.path) return row;

    const wrap = document.createElement('div');
    wrap.className = 'launcher-row-group';
    wrap.append(row, this.#projectPanel(dir, info));
    return wrap;
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
