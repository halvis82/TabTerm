import type { LiveSession } from '@tabterm/shared';
import { groupSessions, isShared, orderedByLayout, type SessionGroup } from './session-groups.js';
import { packTiles, type Tile } from './pack-grid.js';

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

/** The list accepts a dragged session anywhere that is not a group. */
function acceptDrops(area: HTMLElement, onDetach: (session: LiveSession) => void): void {
  area.addEventListener('dragover', (e) => {
    if (draggingOut === undefined) return;
    // Over a group, including its own, this is not a drop target at all: no `preventDefault`,
    // so the browser shows the "no" cursor and a drop there does nothing.
    if ((e.target as HTMLElement).closest('.session-group')) return;
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
    if ((e.target as HTMLElement).closest('.session-group')) return;
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
  const items = [...grid.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
  if (items.length === 0) return;
  const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  if (columns < 2) {
    // One column, or a grid that has not been laid out. Nothing to arrange, and explicit places
    // would only get in the way of the browser doing the simple thing.
    for (const item of items) item.style.removeProperty('grid-row');
    return;
  }

  const tiles: Tile[] = items.map((item) => {
    const [across, down] = (item.dataset['tile'] ?? '1x1').split('x');
    return { columns: Number(across) || 1, rows: Number(down) || 1 };
  });

  const places = packTiles(tiles, columns);
  items.forEach((item, at) => {
    const place = places[at];
    const tile = tiles[at];
    if (!place || !tile) return;
    const width = Math.max(1, Math.min(tile.columns, columns));
    item.style.gridColumn = `${String(place.column)} / span ${String(width)}`;
    item.style.gridRow = `${String(place.row)} / span ${String(Math.max(1, tile.rows))}`;
  });
}

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
  // The list is rebuilt often and each rebuild makes a new grid, so the old one's observer goes
  // with it rather than piling up.
  const parent = grid.parentElement;
  if (parent) {
    new MutationObserver((changes, self) => {
      if (!grid.isConnected) {
        observer.disconnect();
        self.disconnect();
      }
      void changes;
    }).observe(parent, { childList: true, subtree: true });
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
    grid.append(buildSharedTab(group, options, grid));
  }
  wrap.append(grid);
  /*
   * Placed once the grid has a width, because how many columns there are is the whole input.
   * Re-run whenever that width changes, which is a window resize or the sidebar opening.
   */
  requestAnimationFrame(() => packGrid(grid));
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
 * The panes of one tab, drawn as a row of ordinary cards.
 *
 * A container rather than cards that merely sit beside each other: a group that straddles a row
 * boundary loses the cue entirely, and that is the one thing adjacency cannot survive.
 *
 * It mirrored the workspace's own splits at first, so a stacked pair was drawn stacked. That was
 * the wrong trade and he said so: mirroring a tree means a card's size comes from the shape of the
 * tab, so one pane of a three pane tab was drawn tall with a stretched footer while its neighbours
 * were short. **A card is a card.** They are all the same size here, in the order the panes are in,
 * wrapping when there are more than fit, which is also what the tab does to fit them on a screen.
 */
function buildSharedTab(
  group: SessionGroup,
  options: SessionsOptions,
  grid: HTMLElement,
): HTMLElement {
  const box = document.createElement('section');
  box.className = 'session-group';
  if (group.workspaceId !== undefined) box.dataset['workspaceId'] = group.workspaceId;

  const members = orderedByLayout(group);
  /*
   * How much of the grid this tab takes: as many columns as it has panes up to the cap, and one
   * row per wrapped row of cards inside it. That is what the packing works in. See `pack-grid.ts`.
   */
  const across = Math.min(members.length, MAX_GROUP_COLUMNS);
  box.dataset['tile'] =
    `${String(across)}x${String(Math.ceil(members.length / Math.max(1, across)))}`;
  /**
   * As many columns as it has panes, up to the cap, and no more.
   *
   * It spanned the whole row first, which turned a pair of terminals into a banner across the
   * list. Each card then keeps the width it would have had on its own, which is the point: the
   * grouping is a background and an order, not a different kind of card.
   */
  // The span is set by the packing, which knows how many columns there are. See `packGrid`.
  box.style.gridColumn = `span ${String(across)}`;

  const head = document.createElement('header');
  head.className = 'session-group-head';
  const what = document.createElement('span');
  what.className = 'session-group-title';
  what.textContent = `${String(members.length)} panes in one tab`;
  head.append(what);
  box.append(head);

  const body = document.createElement('div');
  body.className = 'session-group-body';
  for (const { session } of members) {
    const card = buildSessionCard(session, options);
    // Only a card in a group can be dragged, because out of the group is all the gesture means.
    if (options.onDetach) dragOutOfGroup(card, session, grid);
    body.append(card);
  }
  box.append(body);

  /**
   * The whole thing opens the tab, not only the cards in it.
   *
   * The background between and around them is part of the same object, and a person aiming at a
   * group aims at the group. A press that began on a card is left alone: that card has its own
   * answer, which is to open the tab **and** put the keyboard in that pane.
   */
  box.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.session-card')) return;
    const first = members[0]?.session;
    if (first) options.onOpen(first);
  });

  return box;
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
