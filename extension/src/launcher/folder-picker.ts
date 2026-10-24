import { resolveTypedPath, unresolveTypedPath } from './typed-path.js';

/**
 * A path box with the folders under it, the way the start screen picks a folder.
 *
 * Asked for in a new pane: "there should just be a section for open a folder and it should have
 * the same folder picker as the homepage. so you can either select a folder with the smoooth
 * navigation with tabbing ... or you can click the subfolders". So it is the same thing: a box
 * that Tab completes through the daemon, the folders inside wherever the box points shown under
 * it as chips, `..` first, filtered by what has been typed, three rows and then `...`. It draws
 * with the start screen's own classes, so the two look and behave alike.
 *
 * It starts in a folder rather than empty, because a pane already has one: the shell in it is
 * somewhere, and that is where somebody looking for a folder near their work wants to begin.
 *
 * The start screen keeps its own box, because there the box is tangled with templates, the folder
 * check, dropping a path in and a screen that redraws under it. The list under the box is shared:
 * both draw it with `folderList` below, so the folders, `..` and the `...` cannot drift apart.
 */

export interface FolderPickerOptions {
  home: string;
  /** The folder to begin in, absolute. */
  start: string;
  /** Ask the daemon to complete a path, or to list a directory when it ends in a slash. */
  onCompletePath: (partial: string) => void;
  /** Open this folder. */
  onOpen: (path: string) => void;
}

/** Rows of folders shown before `...`. Enough to recognise where you are. */
const ROWS = 3;

export class FolderPicker {
  readonly element: HTMLElement;
  readonly #opts: FolderPickerOptions;
  readonly #input: HTMLInputElement;
  #list: HTMLElement | null = null;
  #listing: { dir: string; entries: readonly string[] } | null = null;

  constructor(opts: FolderPickerOptions) {
    this.#opts = opts;
    this.element = document.createElement('div');
    this.element.className = 'folder-picker';

    const row = document.createElement('div');
    row.className = 'launcher-path-row';
    this.#input = document.createElement('input');
    this.#input.type = 'text';
    this.#input.className = 'launcher-input';
    this.#input.spellcheck = false;
    this.#input.placeholder = '~/Projects/something';
    this.#input.value = withSlash(tildeForm(opts.start, opts.home));

    const open = document.createElement('button');
    open.className = 'launcher-browse folder-picker-open';
    open.textContent = 'Open here';
    open.title = 'Go to this folder. Return, from the box';
    open.addEventListener('click', () => this.#open());
    row.append(this.#input, open);
    this.element.append(row);

    this.#input.addEventListener('keydown', (e) => {
      // A path being typed is not for the shell underneath.
      e.stopPropagation();
      if (e.key === 'Tab') {
        // Tab completes, as it does in a terminal. Moving focus would lose the box.
        e.preventDefault();
        this.#opts.onCompletePath(this.#resolved(this.#input.value));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.#open();
      }
    });
    this.#input.addEventListener('input', () => {
      this.#ensureListing();
      this.#draw();
    });
    this.#ensureListing();
  }

  focus(): void {
    this.#input.focus();
    this.#input.setSelectionRange(this.#input.value.length, this.#input.value.length);
  }

  /** The daemon's answer to `onCompletePath`, either a listing or a completion. */
  pathCompletion(reply: { partial: string; completed: string; matches: readonly string[] }): void {
    // A reply about a directory is its listing; a reply about a fragment is a completion.
    if (reply.partial.endsWith('/')) {
      this.#listing = { dir: reply.partial, entries: reply.matches };
      this.#draw();
      // An older answer can arrive after a newer question, so ask again if it was not for here.
      this.#ensureListing();
      return;
    }
    if (this.#resolved(this.#input.value) !== reply.partial) return;
    if (reply.completed !== reply.partial) {
      // Put back the way it was typed, so `Doc` becomes `Documents` rather than an absolute path.
      this.#input.value = unresolveTypedPath(reply.completed, this.#input.value);
      this.#ensureListing();
    }
    this.#draw();
  }

  #open(): void {
    const typed = this.#input.value.trim();
    this.#opts.onOpen(trimSlash(this.#resolved(typed === '' ? '~' : typed)));
  }

  #resolved(typed: string): string {
    return resolveTypedPath(typed, this.#opts.home);
  }

  /** What has been typed, up to and including the last slash. */
  #typedDir(): string {
    const typed = this.#input.value;
    const cut = typed.lastIndexOf('/');
    return cut === -1 ? '' : typed.slice(0, cut + 1);
  }

  /** The directory the box points into, resolved, always ending in a slash. */
  #currentDir(): string {
    return withSlash(this.#resolved(this.#typedDir()));
  }

  #ensureListing(): void {
    const dir = this.#currentDir();
    if (this.#listing?.dir === dir) return;
    this.#opts.onCompletePath(dir);
  }

  #go(value: string): void {
    this.#input.value = value;
    this.focus();
    this.#ensureListing();
    this.#draw();
  }

  #draw(): void {
    this.#list?.remove();
    this.#list = null;
    if (this.#listing?.dir !== this.#currentDir()) return;
    const list = folderList({
      typed: this.#input.value,
      entries: this.#listing.entries,
      home: this.#opts.home,
      resolve: (typed) => this.#resolved(typed),
      onGo: (value) => this.#go(value),
    });
    this.element.append(list);
    this.#list = list;
    trimToRows(list);
  }
}

/** How many chips to build at most. A home directory can hold hundreds and the list is a means. */
const MAX_FOLDERS = 40;

/**
 * The folders inside wherever a path box points, as chips, `..` first.
 *
 * Filtered by what has been typed after the last slash. A chip puts its folder in the box with a
 * trailing slash, which moves the list into it, and `..` takes one step back up. Both are built
 * from the text as typed, so `Documents/` stays relative and `~/x/` keeps its tilde.
 *
 * Measured into rows by `trimToRows` once it is in the document, which is the only time offsets
 * mean anything.
 */
export function folderList(opts: {
  typed: string;
  entries: readonly string[];
  home: string;
  resolve: (typed: string) => string;
  onGo: (value: string) => void;
}): HTMLElement {
  const { typed, resolve, onGo } = opts;
  const cut = typed.lastIndexOf('/');
  const typedDir = cut === -1 ? '' : typed.slice(0, cut + 1);
  const fragment = typed
    .slice(cut + 1)
    .trim()
    .toLowerCase();
  const matching = opts.entries.filter((name) => name.toLowerCase().startsWith(fragment));

  const list = document.createElement('div');
  list.className = 'launcher-completions';

  // Up first, so it never moves.
  const up = upFrom(typedDir, opts.home);
  if (up !== null) {
    const chip = document.createElement('button');
    chip.className = 'launcher-completion is-up';
    chip.textContent = '..';
    chip.dataset['path'] = resolve(typedDir);
    chip.addEventListener('click', () => onGo(up));
    list.append(chip);
  }
  for (const name of matching.slice(0, MAX_FOLDERS)) {
    const chip = document.createElement('button');
    chip.className = 'launcher-completion';
    chip.textContent = name;
    // The whole path, where a right click can find it. The label is only one segment.
    chip.dataset['path'] = resolve(`${typedDir}${name}`);
    chip.addEventListener('click', () => onGo(`${typedDir}${name}/`));
    list.append(chip);
  }
  if (matching.length > MAX_FOLDERS) {
    const more = document.createElement('div');
    more.className = 'launcher-completion-more';
    more.textContent = `and ${String(matching.length - MAX_FOLDERS)} more, keep typing`;
    list.append(more);
  }
  if (matching.length === 0) {
    const none = document.createElement('div');
    none.className = 'launcher-completion-more';
    none.textContent = fragment === '' ? 'no folders in here' : 'nothing matching';
    list.append(none);
  }
  return list;
}

/**
 * Where `..` goes from the directory part of what is typed, or null at the root.
 *
 * One segment off the text when it has one to lose, so `Documents/` goes to the empty box, which
 * means home, and `~/x/` to `~/`. From home itself, typed as nothing or as `~/`, it goes to the
 * folder above home, written out in full since there is no short form for it. The start screen
 * used to offer `..` at home and do nothing when it was pressed.
 */
export function upFrom(typedDir: string, home: string): string | null {
  if (typedDir === '/') return null;
  const trimmed = typedDir.replace(/\/$/, '');
  if (trimmed === '' || trimmed === '~') {
    if (!home.startsWith('/') || home === '/') return null;
    return withSlash(home.slice(0, home.lastIndexOf('/')) || '/');
  }
  return trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
}

/** Keep `ROWS` rows of chips and say how many more there are. Measured, since names vary. */
export function trimToRows(list: HTMLElement): void {
  const children = [...list.children] as HTMLElement[];
  const rows: number[] = [];
  for (const child of children) if (!rows.includes(child.offsetTop)) rows.push(child.offsetTop);
  if (rows.length <= ROWS) return;
  const cutoff = rows[ROWS] as number;
  let hidden = 0;
  for (const child of children) {
    if (child.offsetTop < cutoff) continue;
    child.remove();
    hidden++;
  }
  const more = document.createElement('span');
  more.className = 'launcher-completion is-more';
  more.textContent = '...';
  more.title = `${String(hidden)} more. Type to narrow the list.`;
  list.append(more);
  if (more.offsetTop >= cutoff) list.children[list.children.length - 2]?.remove();
}

/** `/Users/me/x` as `~/x`, which is how the box shows a path under home. */
function tildeForm(path: string, home: string): string {
  if (home.startsWith('/') && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function withSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
