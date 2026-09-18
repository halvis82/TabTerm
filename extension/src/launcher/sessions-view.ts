import type { LiveSession } from '@tabterm/shared';
import { groupSessions, isShared, orderedByLayout, type SessionGroup } from './session-groups.js';
import { packTiles, type Tile } from './pack-grid.js';
import { roundedPath, type Point } from './rounded-path.js';

/**
 * Sessions that already exist, on the page you see when you open a tab.
 *
 * The point of this list is recognition. A path is not enough: four shells in the same
 * repository look identical by directory, and the one you want is the one that printed the thing
 * you remember. So every row carries the last lines of its actual screen.
 *
 * The distinction that matters most is whether a tab is showing it. A session nobody is looking
 * at is invisible otherwise, which is the case this list exists for.
 */

export interface SessionsOptions {
  sessions: () => readonly LiveSession[];
  /** Open a session, either by focusing the tab that has it or by attaching here. */
  onOpen: (session: LiveSession) => void;
  /** Absent where ending a session is not one of the things on offer, as in a pane chooser. */
  onClose?: (session: LiveSession) => void;
  /**
   * Take a session out of the tab it shares, dragged out of its group.
   *
   * Absent where that is not on offer, as in a pane chooser, which leaves the cards undraggable
   * rather than draggable and inert.
   */
  onDetach?: (session: LiveSession) => void;
  /**
   * A session that has just been dragged out, outlined for a moment so the eye can follow it.
   *
   * It leaves its group and lands somewhere else in the list, in its place by age, which is a jump
   * of some distance with nothing to connect the two positions. See `.session-card.is-landed`.
   */
  landed?: string;
  home: string;
}

const HOME = /^\/Users\/[^/]+/;

export function shortPath(path: string, home: string): string {
  // A template literal starting with ~ is never empty, so home itself renders as plain "~".
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path.replace(HOME, '~');
}

/**
 * How much of a path a card has room for.
 *
 * Generous, because the point is only to stop the longest ones from pushing the badge off the
 * card. Anything shorter than this is left exactly as it is.
 */
const PATH_LIMIT = 34;

/**
 * A long path, shortened from the **left**.
 *
 * The end of a path is what distinguishes it. Cut from the right, a screen full of cards under
 * one project reads "~/Documents/personal_cod..." on every line, which is a column of identical
 * text where the whole purpose is telling them apart. The last segment is never cut, however
 * long it is, because a card showing only an ellipsis says less than nothing.
 */
export function shortenFromLeft(path: string, limit = PATH_LIMIT): string {
  if (path.length <= limit) return path;
  const segments = path.split('/');
  const last = segments[segments.length - 1] ?? path;
  let kept = last;
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const wider = `${segments[i] ?? ''}/${kept}`;
    // One for the ellipsis character that will stand in for everything dropped.
    if (wider.length + 1 > limit) break;
    kept = wider;
  }
  return `…/${kept}`;
}

/** How long ago, in the shortest form that is still specific. */
export function since(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  /**
   * Days and the hours after them, because a day on its own is too coarse here.
   *
   * "2d ago" covers anything from two days to nearly three, and these are terminals somebody left
   * running: which of two sessions is the older one, and whether the one they are thinking of is
   * from yesterday evening or the morning before, is exactly what this line is read for.
   *
   * Rounded down to the day rather than to the nearest, so the hours are what is left over and the
   * two halves agree. Rounding the day and then taking a remainder produces "3d 21h", which reads
   * as nearly four days and is nearly three.
   */
  const days = Math.floor(hours / 24);
  const leftover = hours - days * 24;
  return leftover === 0 ? `${String(days)}d ago` : `${String(days)}d ${String(leftover)}h ago`;
}

/** Shells, which are what a session is when nothing more interesting is true of it. */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', '-zsh', '-bash', 'login']);

/**
 * What a session is doing, in the fewest words that distinguish it from the others.
 *
 * The order is most specific first. A running command says the most; a program that is not a
 * shell says the next most; and after that the **last command run here** says far more than the
 * name of the shell it ran in.
 *
 * "shell" was the answer for almost every card, which made the one line that is supposed to tell
 * them apart the one line they all shared. It is kept only for a session that has genuinely never
 * run anything, where it is the truth.
 */
export function describe(session: LiveSession): string {
  // A name somebody typed wins outright. It is the only line here they wrote themselves, and it
  // says what the terminal is for, which nothing derived from its output can.
  if (session.name) return session.name;
  if (session.busy) return session.lastCommand ?? session.process ?? 'running';
  if (session.process && !SHELLS.has(session.process)) return session.process;
  if (session.lastCommand) return session.lastCommand;
  /*
   * An idle shell says what it last did, because "shell" says nothing at all.
   *
   * Every terminal that has gone quiet was labelled the same word, which made the one line meant
   * to tell them apart the one line they all shared. What it last ran is the thing somebody
   * recognises it by.
   */
  if (session.ranLast) return shellRanLabel(session.ranLast);
  return 'shell';
}

/**
 * How much of a command fits beside the word, before it pushes the size and the age off the line.
 *
 * Measured against the example that prompted this: `ssh argonath@192.168.1.168` is twenty six
 * characters, so a cap of twenty eight let the whole thing through and the line ran into the
 * figures beside it. Eighteen keeps the verb and enough of the host to know which machine.
 */
const RAN_LAST_MAX = 18;

/**
 * A shell described by the last thing it ran.
 *
 * Kept as "shell" plus the command rather than the command alone, because a bare `ls` beside three
 * other bare commands does not say these are shells, and the word is what makes the line read as a
 * description rather than as a name somebody chose.
 *
 * Cut from the right with an ellipsis: a command's beginning is what identifies it, so `ssh
 * argonath@192.168.1.168` becomes `ssh argonath@192.16…` rather than losing the `ssh`.
 */
export function shellRanLabel(command: string, max = RAN_LAST_MAX): string {
  const clean = command.replace(/\s+/g, ' ').trim();
  if (clean === '') return 'shell';
  return clean.length <= max ? `shell - ${clean}` : `shell - ${clean.slice(0, max - 1)}…`;
}

/**
 * Dragging a session out of the tab it shares.
 *
 * A group says these panes are in one tab, and taking one out of the picture is the plainest way
 * to say take it out of that tab. The drop is refused over any group, including the one it came
 * from, so the gesture has exactly one meaning: out. There is no dragging **into** a tab here,
 * which is a different operation with a different consequence and already has its own way in.
 *
 * Which session is moving is kept here rather than read from the drag. `dataTransfer` deliberately
 * refuses to be read during `dragover`, and `dragover` is where the decision to accept or refuse
 * has to be made.
 */
let draggingOut: LiveSession | undefined;
let draggingSince = 0;

/**
 * How long a drag may hold the list still.
 *
 * `dragend` is what normally clears this and it is reliable, but a flag that freezes a list is not
 * a flag to leave without a floor under it: a drag that somehow never ends would stop `Running now`
 * updating for as long as the page is open, and nothing on screen would say why. Longer than any
 * real drag across a list, short enough to be invisible if it is ever reached.
 */
const DRAG_HOLDS_LIST_MS = 8000;

/**
 * Whether a session is being carried right now.
 *
 * Asked by whoever redraws this list. The list redraws on its own whenever what is running changes,
 * and a redraw replaces the card under the pointer with a new element: the browser then has nothing
 * to finish the drag with and the gesture ends in the middle. Measured under a full test run, where
 * other terminals starting and ending kept the list moving, and the drag never even began.
 */
export function isDraggingSession(): boolean {
  if (draggingOut === undefined) return false;
  return Date.now() - draggingSince < DRAG_HOLDS_LIST_MS;
}

const DRAG_TYPE = 'application/x-tabterm-session';

function dragOutOfGroup(card: HTMLElement, session: LiveSession, grid: HTMLElement): void {
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    draggingOut = session;
    draggingSince = Date.now();
    e.dataTransfer?.setData(DRAG_TYPE, session.sessionId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragging');
    // The list says a drag is happening, so the groups can show that they are not a destination.
    grid.classList.add('is-dragging-out');
  });
  card.addEventListener('dragend', () => {
    draggingOut = undefined;
    card.classList.remove('is-dragging');
    grid.classList.remove('is-dragging-out');
  });
  /*
   * A drag begins with a press, and a press on a card opens it. Without this the session opened
   * in its tab the moment the drag ended, which is the opposite of taking it out of that tab.
   */
  card.addEventListener('click', (e) => {
    if (!card.classList.contains('was-dragged')) return;
    card.classList.remove('was-dragged');
    e.stopPropagation();
  });
}

/** Whether what is under the pointer is part of a tab with other panes in it. */
function belongsToATab(target: EventTarget | null): boolean {
  /*
   * Any element, not only an HTML one. The colour behind a tab is drawn as an outline, so what is
   * under the pointer there is an SVG element, which is an `Element` and is **not** an
   * `HTMLElement`. Asking for the narrower type let a drop land on a tab and take a session out of
   * it, which is the one thing this refusal exists to prevent.
   */
  if (!(target instanceof Element)) return false;
  return target.closest('.session-wash, .session-card[data-group]') !== null;
}

/** The list accepts a dragged session anywhere that is not part of a tab. */
function acceptDrops(area: HTMLElement, onDetach: (session: LiveSession) => void): void {
  area.addEventListener('dragover', (e) => {
    if (draggingOut === undefined) return;
    /*
     * Over anything belonging to a tab, including its own, this is not a drop target at all: no
     * `preventDefault`, so the browser shows the "no" cursor and a drop there does nothing.
     *
     * Asked of the card rather than of a box around it. The cards of a tab are members of the one
     * grid now, with the tab's colour washed behind them, so what says "this belongs to a tab" is
     * the card itself. See `appendSharedTab`.
     */
    if (belongsToATab(e.target)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    area.classList.add('is-drop-target');
  });
  area.addEventListener('dragleave', (e) => {
    if (e.target === area) area.classList.remove('is-drop-target');
  });
  area.addEventListener('drop', (e) => {
    area.classList.remove('is-drop-target');
    const moving = draggingOut;
    draggingOut = undefined;
    if (moving === undefined) return;
    if (belongsToATab(e.target)) return;
    e.preventDefault();
    // Marked so the click that ends this drag does not also open the session. See `dragOutOfGroup`.
    area
      .querySelector(`.session-card[data-session-id="${CSS.escape(moving.sessionId)}"]`)
      ?.classList.add('was-dragged');
    onDetach(moving);
  });
}

/**
 * Put every tile where the packing says, once the grid has a width to pack into.
 *
 * The browser places these itself otherwise, in order, backfilling a gap only with something that
 * comes after it. That left a column three rows deep empty beside a seven pane tab, because the
 * cards that fit there were older and had already been placed above. See `pack-grid.ts`.
 *
 * Measured rather than assumed: how many columns there are depends on the width of the window and
 * of whatever else Chrome is showing down the side, and it changes without this list being rebuilt.
 */
function packGrid(grid: HTMLElement): void {
  const items = [...grid.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.dataset['tile'] !== undefined,
  );
  if (items.length === 0) return;

  /*
   * Everything goes back where the browser would put it before anything is counted.
   *
   * A place in a column that is not there makes the column: a grid of two tracks with something
   * placed in the fifth reports `258px 258px 0px 0px 125px`, so the count read back is the one the
   * last pack invented rather than the one the window allows. Every later pack then agreed with it,
   * the cards were squeezed below their own minimum, and the list ran off the side of the page
   * until it was reloaded. Reported after zooming out and back in.
   *
   * The placements are put back below in the same task, so nothing is ever drawn unplaced.
   */
  const placed = [...grid.querySelectorAll<HTMLElement>('[style*="grid-"]')];
  for (const el of placed) {
    el.style.removeProperty('grid-column');
    el.style.removeProperty('grid-row');
  }

  const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  if (columns < 1) {
    // A grid nothing has laid out yet. There is no width to pack into, and inventing one is how
    // the fault above happened in the first place.
    return;
  }

  const tiles: Tile[] = items.map((item) => {
    /*
     * A tab's shape is worked out here, where the number of columns is known.
     *
     * A tab of seven panes wants three across, and in a two column list it gets two: four rows of
     * two with one on the last. Deciding that where the cards are built produced a shape for a
     * width the list did not have.
     */
    const panes = Number(item.dataset['panes'] ?? '0');
    if (panes > 0) {
      const wide = Math.max(1, Math.min(panes, MAX_GROUP_COLUMNS, columns));
      const rows = Math.ceil(panes / wide);
      return { columns: wide, rows, lastRow: panes - wide * (rows - 1) };
    }
    const [across, down] = (item.dataset['tile'] ?? '1x1').split('x');
    return { columns: Number(across) || 1, rows: Number(down) || 1 };
  });

  /*
   * What this pack was done for, said out loud on the grid itself.
   *
   * The number is the whole input and it is read back from the browser, so when it is wrong every
   * position on the page is wrong together and nothing on the page says why. It is also what a
   * check has to ask about: the fault this exists to prevent is a pack done for more columns than
   * the window has, and the placements alone do not show it when there are few enough cards to fit
   * in the first row either way.
   */
  grid.dataset['columns'] = String(columns);

  const places = packTiles(tiles, columns);
  items.forEach((item, at) => {
    const place = places[at];
    const tile = tiles[at];
    if (!place || !tile) return;
    const width = Math.max(1, Math.min(tile.columns, columns));
    item.style.gridColumn = `${String(place.column)} / span ${String(width)}`;
    item.style.gridRow = `${String(place.row)} / span ${String(Math.max(1, tile.rows))}`;

    /*
     * And the cards of a tab fill the rectangle its wash was given, in reading order.
     *
     * They are members of this grid rather than of the wash, which is the whole point: a card in a
     * tab and a card on its own are the same size and sit on the same pitch. The wash is behind
     * them and only says which of them belong together.
     */
    const group = item.dataset['group'];
    if (!item.classList.contains('session-wash') || group === undefined) return;
    const cards = [...grid.querySelectorAll(`.session-card[data-group="${CSS.escape(group)}"]`)];
    cards.forEach((card, index) => {
      if (!(card instanceof HTMLElement)) return;
      card.style.gridColumn = String(place.column + (index % width));
      card.style.gridRow = String(place.row + Math.floor(index / width));
    });
    /*
     * And the colour is cut to the shape the cards actually make, so a short last row leaves a
     * notch rather than a block of empty blue. Measured from the cards themselves, which is the
     * only thing that knows where the rows fall once the browser has laid them out.
     */
    shapeWash(
      item,
      cards.filter((c): c is HTMLElement => c instanceof HTMLElement),
    );
  });
}

/**
 * Cut a wash to the shape of the cards it belongs to.
 *
 * A tab of seven panes is three across and three down with one card on the last row, so its colour
 * is an L rather than a square: "the group should only be the size it actually needs to be", and
 * the two cells its last row does not reach are for other terminals.
 *
 * Measured from the cards rather than worked out from the numbers, because where the rows fall
 * depends on the gap, the border and whatever the browser did with the fractions. A full block
 * needs no cutting and is left alone, which also means the ordinary case pays nothing.
 */
function shapeWash(wash: HTMLElement, cards: readonly HTMLElement[]): void {
  const ink = wash.querySelector('svg.session-wash-ink');
  const outline = ink?.querySelector('path');
  if (!ink || !outline) return;
  const box = wash.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return;

  const w = Math.round(box.width);
  const h = Math.round(box.height);
  ink.setAttribute('viewBox', `0 0 ${String(w)} ${String(h)}`);

  /*
   * Where the outline turns back on itself, when it does. The last card's right edge and top edge
   * are the two cuts, measured after the browser has laid the cards out rather than worked out from
   * the numbers: where a row falls depends on the gap, the border, and what was done with the
   * fractions.
   */
  const last = cards[cards.length - 1]?.getBoundingClientRect();
  const widest = Math.max(...cards.map((c) => c.getBoundingClientRect().right));
  const notched = last !== undefined && cards.length > 1 && widest - last.right > 8;

  /**
   * Where the notch is cut, and it is measured from the row **above** rather than from the row
   * below it.
   *
   * Cutting at the last row's top less the reach put the edge exactly where the colour of whatever
   * sits in the notch begins, so the two touched and read as one tab. Every other boundary in this
   * list is a gap less twice the reach, and this one has to be the same: the bottom of the row
   * above, plus the reach, exactly as if the tab ended there.
   */
  const above = notched
    ? Math.max(
        ...cards
          .map((c) => c.getBoundingClientRect().bottom)
          .filter((bottom) => bottom <= (last?.top ?? 0) + 1),
      )
    : 0;

  const corners: Point[] = notched
    ? [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: above - box.top + REACH },
        { x: last.right - box.left + REACH, y: above - box.top + REACH },
        { x: last.right - box.left + REACH, y: h },
        { x: 0, y: h },
      ]
    : [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ];

  outline.setAttribute('d', roundedPath(corners, WASH_RADIUS));
}

/** How far the colour reaches past the cards, which the stylesheet also uses. See `--wash-reach`. */
const REACH = 4;
/** The same curve the cards have, so the two read as one family. */
const WASH_RADIUS = 12;

/**
 * Pack again when the grid changes width, which is not something a rebuild is told about.
 *
 * A window resized, a sidebar opened, the browser's own tab strip moved to the side: all of them
 * change how many columns fit and none of them redraw this list.
 */
function watchWidth(grid: HTMLElement): void {
  let last = 0;
  const observer = new ResizeObserver(() => {
    const width = Math.round(grid.getBoundingClientRect().width);
    if (width === last) return;
    last = width;
    packGrid(grid);
  });
  observer.observe(grid);

  /*
   * And again whenever the tab comes back into view, whatever the width says.
   *
   * A hidden tab runs no animation frames, and a resize observer reports nothing to it either.
   * Chrome's zoom is per origin, so zooming any TabTerm tab changes the width of every start
   * screen open anywhere, including the ones nobody is looking at. Zoom out and back in and the
   * width ends where it started, so when the tab returns the observer has nothing to say, while
   * whatever packed in between packed for a window that is no longer there. Reported as the list
   * going weird after a zoom out and back, and coming right on a refresh.
   */
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') packGrid(grid);
  };
  document.addEventListener('visibilitychange', onVisible);

  // The list is rebuilt often and each rebuild makes a new grid, so the old one's observer goes
  // with it rather than piling up.
  const parent = grid.parentElement;
  if (parent) {
    new MutationObserver((changes, self) => {
      if (!grid.isConnected) {
        observer.disconnect();
        document.removeEventListener('visibilitychange', onVisible);
        self.disconnect();
      }
      void changes;
    }).observe(parent, { childList: true, subtree: true });
  }
}

/**
 * Place the list now, for a caller that has just put it in the document.
 *
 * The frame and the timer below cover a list that is built and left alone. Neither is any use to a
 * tab nobody is looking at: it runs no animation frames at all, and Chrome slows a timer in a
 * hidden tab to once a second and eventually to once a minute, so a start screen rebuilt in the
 * background spent up to a minute with its cards wherever the browser happened to put them and no
 * colour behind the tabs at all. A hidden tab measures perfectly well when it is asked; it is only
 * being told that it cannot do.
 */
export function placeSessions(root: ParentNode): void {
  for (const grid of root.querySelectorAll('.session-grid')) {
    if (grid instanceof HTMLElement) packGrid(grid);
  }
}

export function buildSessions(options: SessionsOptions): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'sessions';

  const sessions = options.sessions();
  if (sessions.length === 0) return wrap;

  const heading = document.createElement('h2');
  heading.className = 'sessions-heading';
  heading.textContent = 'Running now';
  const count = document.createElement('span');
  count.className = 'sessions-count';
  count.textContent = String(sessions.length);
  heading.append(count);
  wrap.append(heading);

  const grid = document.createElement('div');
  grid.className = 'session-grid';
  // Scrolls past a few rows rather than pushing everything else off the page. Sessions now
  // genuinely persist, so this list can be long on a machine that has been up for a while.
  // The grid always caps itself at two rows and scrolls past that, so there is nothing to
  // switch on: a class that only appeared past six meant the cap depended on how many there
  // were rather than on how much room there is.

  /*
   * Grouped, so a tab with several panes reads as one thing rather than several unrelated ones.
   *
   * Every session still appears, and a session alone in its tab is drawn exactly as it was. The
   * order is unchanged: groups sit where their oldest member sat. See `session-groups.ts`.
   */
  for (const group of groupSessions(sessions)) {
    if (!isShared(group)) {
      const only = group.sessions[0];
      if (!only) continue;
      const card = buildSessionCard(only, options);
      // One card, one cell. See `packGrid`.
      card.dataset['tile'] = '1x1';
      grid.append(card);
      continue;
    }
    appendSharedTab(group, options, grid);
  }
  wrap.append(grid);
  /*
   * Placed once the grid has a width, because how many columns there are is the whole input.
   *
   * On a frame **and** on a timer. A hidden tab runs neither animation frames nor resize
   * observers, so a start screen built in the background was never placed at all: its cards fell
   * where the browser put them and the colour behind a tab was never drawn. A timer runs in a
   * hidden tab, slowly, which is exactly the right speed for a page nobody is looking at.
   *
   * Placing twice costs nothing: it is the same arithmetic on the same numbers.
   */
  requestAnimationFrame(() => packGrid(grid));
  setTimeout(() => packGrid(grid), 60);
  watchWidth(grid);
  /*
   * The whole section takes the drop, not only the grid.
   *
   * "Out of the group" is what the gesture means, and somebody making it lets go wherever the
   * pointer happens to be, which is often the space beside the list rather than another card.
   */
  const onDetach = options.onDetach;
  if (onDetach) acceptDrops(wrap, onDetach);
  return wrap;
}

/**
 * The panes of one tab: ordinary cards, with the tab's colour washed behind them.
 *
 * Three designs, and this is the one he asked for after seeing the other two. It mirrored the
 * workspace's own splits first, which made a card's size come from the shape of its tab. Then the
 * cards were equal but lived inside a box with a title, and a box is taller than what it contains:
 * the cards beside it lined up with nothing, and lengthening those to compensate only moved the
 * mismatch. "Keep a perfect grid with all of them the same size, but the blue background just goes
 * around them extending slightly past, with no title."
 *
 * So the cards are members of the one grid like every other card, and the wash is a separate item
 * placed over the same cells, behind them, reaching a few pixels past on every side. Nothing is
 * nested, so nothing can drift: every card in the list sits on the same pitch whether or not it
 * belongs to a tab.
 */
function appendSharedTab(group: SessionGroup, options: SessionsOptions, grid: HTMLElement): void {
  const members = orderedByLayout(group);
  const across = Math.min(members.length, MAX_GROUP_COLUMNS);
  const down = Math.ceil(members.length / Math.max(1, across));
  const id = group.workspaceId ?? members[0]?.session.sessionId ?? '';

  /*
   * The wash comes first in the order, so it is painted before the cards that sit on it. It is a
   * grid item like any other and the packing gives it the whole rectangle. See `packGrid`.
   */
  const wash = document.createElement('div');
  wash.className = 'session-wash';
  /*
   * Drawn rather than styled, because the shape is not always a rectangle: a tab whose last row is
   * short turns back on itself, and a box can only have corners at its own four. The outline is one
   * path with every corner rounded, the inward one included. See `rounded-path.ts`.
   */
  const ink = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ink.setAttribute('class', 'session-wash-ink');
  ink.setAttribute('preserveAspectRatio', 'none');
  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ink.append(outline);
  wash.append(ink);
  /*
   * Three numbers: how wide, how tall, and how much of the last row is actually used. Seven panes
   * are three across and three down with one card on the bottom row, and the two cells it does not
   * reach belong to whoever needs them. See `pack-grid.ts`.
   */
  /*
   * How many panes, rather than a shape worked out here.
   *
   * The shape depends on how many columns the grid turns out to have, and a narrow window gives
   * fewer than a tab has panes. Working it out here meant a tab of three panes in a two column
   * list still claimed to be one row of three, and its third card was placed outside the colour
   * that was supposed to be behind it. The count is the fact; the shape is worked out where the
   * width is known. See `packGrid`.
   */
  wash.dataset['panes'] = String(members.length);
  wash.dataset['tile'] = `${String(across)}x${String(down)}`;
  wash.dataset['group'] = id;
  if (group.workspaceId !== undefined) wash.dataset['workspaceId'] = group.workspaceId;
  wash.title = `${String(members.length)} panes in one tab`;
  /*
   * Pressing the colour around the cards opens that tab, which is what it is a picture of. The
   * cards on top answer for themselves, and a press that lands on one never reaches here.
   */
  wash.addEventListener('click', () => {
    const first = members[0]?.session;
    if (first) options.onOpen(first);
  });
  grid.append(wash);

  for (const { session } of members) {
    const card = buildSessionCard(session, options);
    card.dataset['group'] = id;
    // Only a card in a tab with others can be dragged, because out of that tab is all it means.
    if (options.onDetach) dragOutOfGroup(card, session, grid);
    /*
     * The wash lights up with any of its cards, so the tab reads as one thing under the pointer
     * without the cards being inside anything.
     */
    card.addEventListener('mouseenter', () => wash.classList.add('is-lit'));
    card.addEventListener('mouseleave', () => wash.classList.remove('is-lit'));
    grid.append(card);
  }
}

/**
 * The widest a group may be, in cards.
 *
 * A list is usually three or four columns, and a group wider than the list asks the grid for
 * columns that are not there. Three keeps the common shapes exact and lets the rare ones wrap
 * inside the group, which is what the tab itself does to fit them on a screen.
 */
const MAX_GROUP_COLUMNS = 3;

export function buildSessionCard(session: LiveSession, options: SessionsOptions): HTMLElement {
  const card = document.createElement('article');
  card.className = 'session-card';
  card.dataset['sessionId'] = session.sessionId;
  // The folder it is in, so a right click on the card can act on that folder.
  card.dataset['cwd'] = session.cwd;
  card.tabIndex = 0;
  // Attached and unattached are the whole point of the list, so they differ in more than a word.
  /*
   * The same question the badge's words ask, so they cannot disagree.
   *
   * This read `attached` alone while the words read "a tab holds it", and the two stopped meaning
   * the same thing the moment a sleeping tab started counting as held. What that looked like was
   * two cards both saying "open in a tab" in different colours, one with the accent badge and the
   * blue dot and one grey, which is a difference the interface was drawing for no reason anybody
   * could name.
   */
  card.dataset['state'] = isInATab(session) ? 'attached' : 'detached';
  if (session.busy) card.dataset['busy'] = 'true';
  /*
   * Outlined for a moment, because it has just arrived from somewhere else on the page.
   *
   * The animation is one shot and the class is set by whoever rebuilt the list, so a card that is
   * rebuilt for an unrelated reason a second later does not flash again.
   */
  if (options.landed === session.sessionId) card.classList.add('is-landed');

  const head = document.createElement('header');
  head.className = 'session-head';

  const dot = document.createElement('span');
  dot.className = 'session-dot';
  head.append(dot);

  const title = document.createElement('span');
  title.className = 'session-title';
  title.textContent = shortenFromLeft(shortPath(session.cwd, options.home));
  // The whole path on hover, since shortening throws the beginning of it away.
  title.title = session.cwd;
  head.append(title);

  const badge = document.createElement('span');
  badge.className = 'session-badge';
  // Said plainly, because "attached" is jargon for something people think of as "open".
  badge.textContent = badgeTextFor(session);
  head.append(badge);

  card.append(head);

  /**
   * The screen, small.
   *
   * A miniature of the terminal rather than a paragraph of its text: monospaced, dark, aligned
   * on its own left edge, with the last line at the bottom where a terminal keeps it. The point
   * is recognition at a glance, and a screen you recognize looks like a screen.
   *
   * Text rather than an image, still. It stays sharp at any zoom, costs nothing to produce, and
   * cannot be a photograph of a terminal that has since moved on.
   */
  const preview = document.createElement('div');
  preview.className = 'session-screen';
  if (session.preview.length === 0) {
    preview.classList.add('is-empty');
    preview.textContent = 'Nothing on screen yet';
  } else {
    for (const line of session.preview) {
      const row = document.createElement('div');
      row.className = 'session-line';
      // A blank line still occupies a row, or the miniature closes up and stops looking like
      // the screen it is a picture of.
      row.textContent = line === '' ? '\u00a0' : line;
      preview.append(row);
    }
  }
  card.append(preview);

  const foot = document.createElement('footer');
  foot.className = 'session-foot';

  const what = document.createElement('span');
  what.className = 'session-what';
  what.textContent = describe(session);
  foot.append(what);

  const memory = document.createElement('span');
  memory.className = 'session-memory';
  memory.textContent = formatBytes(session.memoryBytes);
  // Said in full where there is room for it, because the number is only half the story.
  memory.title = session.attached
    ? 'Memory used by this session outside Chrome. The tab showing it costs more on top.'
    : 'Memory used by this session';
  foot.append(memory);

  const when = document.createElement('span');
  when.className = 'session-when';
  when.textContent = since(session.startedAt);
  foot.append(when);

  // Only where ending one is on offer. A pane asking which session to take here should not
  // also be a place to destroy one by clicking slightly wrong.
  const onClose = options.onClose;
  if (onClose) {
    const close = document.createElement('button');
    close.className = 'session-close';
    close.title = 'End this session';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      // Without this the click also opens the session it just ended.
      e.stopPropagation();
      onClose(session);
    });
    foot.append(close);
  }

  card.append(foot);

  card.addEventListener('click', () => options.onOpen(session));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      options.onOpen(session);
    }
  });

  return card;
}

/** Bytes as a person reads them. Nothing here needs more than one decimal. */
export function formatBytes(bytes: number): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${String(Math.round(bytes / 1024))} KB`;
  if (mb < 100) return `${(Math.round(mb * 10) / 10).toString()} MB`;
  return `${String(Math.round(mb))} MB`;
}

/**
 * What a card says about where a session is.
 *
 * `attached` is a live page. Chrome discards tabs it has not needed for a while: the tab stays in
 * the strip, the page is thrown away, and the socket goes with it. So terminals sitting in a window
 * somebody had not looked at for an hour were labelled `background`, which is also the name of the
 * state that starts the timer that ends a session. The label was alarming as well as wrong.
 *
 * Nothing was ever at risk. The rule that ends a session asks whether a **tab** holds it, and this
 * now asks the same question.
 */
export function badgeTextFor(session: Pick<LiveSession, 'attached' | 'inTab'>): string {
  return isInATab(session) ? 'open in a tab' : 'background';
}

/**
 * Whether a tab is holding this session, which decides both what the card says and how it looks.
 *
 * One function because they are one question. The words and the colour were worked out separately,
 * and they drifted the moment a tab Chrome had put to sleep started counting as a tab: the card
 * said "open in a tab" and was still painted as though nothing held it.
 */
export function isInATab(session: Pick<LiveSession, 'attached' | 'inTab'>): boolean {
  return session.attached || session.inTab;
}
