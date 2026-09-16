import type { LayoutNode, LiveSession } from '@tabterm/shared';
import { columnsWide, groupSessions, isShared, type SessionGroup } from './session-groups.js';

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
      if (only) grid.append(buildSessionCard(only, options));
      continue;
    }
    grid.append(buildSharedTab(group, options));
  }
  wrap.append(grid);
  return wrap;
}

/**
 * The panes of one tab, drawn the way that tab is arranged.
 *
 * A container rather than cards that merely sit beside each other: a group that straddles a row
 * boundary loses the cue entirely, and that is the one thing adjacency cannot survive.
 *
 * The arrangement is the workspace's own. Two panes side by side are drawn side by side and two
 * stacked are drawn stacked, because somebody recognising a terminal they left running recognises
 * the shape of it, and cards in arbitrary order are a worse answer than one that looks like what
 * they will get back.
 */
function buildSharedTab(group: SessionGroup, options: SessionsOptions): HTMLElement {
  const box = document.createElement('section');
  box.className = 'session-group';
  if (group.workspaceId !== undefined) box.dataset['workspaceId'] = group.workspaceId;
  /**
   * As many columns as the tab is wide, and no more.
   *
   * The first version gave every group the whole row, which turned a pair of terminals into a
   * banner across the list. A tab of two side by side is two cards wide; a tab of two stacked is
   * one card wide and two tall. Each card then keeps the size it would have had on its own, which
   * is the point: the grouping is a background and an arrangement, not a different kind of card.
   *
   * Capped, because a tab with five panes is wider than the list and a group that asks for more
   * columns than exist gets put somewhere nobody meant. Past the cap it wraps inside itself, which
   * is the same thing the tab does to fit them on a screen.
   */
  const wide = group.layout ? Math.min(columnsWide(group.layout), MAX_GROUP_COLUMNS) : 1;
  box.style.gridColumn = `span ${String(wide)}`;

  const head = document.createElement('header');
  head.className = 'session-group-head';
  const what = document.createElement('span');
  what.className = 'session-group-title';
  what.textContent = `${String(group.sessions.length)} panes in one tab`;
  head.append(what);
  box.append(head);

  const body = document.createElement('div');
  body.className = 'session-group-body';
  /*
   * Null when every pane in the arrangement has gone, which the caller has already ruled out by
   * only building this for a group with members. Kept explicit so the body is never given one.
   */
  const shape = group.layout ? buildLayoutNode(group.layout, group, options) : null;
  if (shape) body.append(shape);
  box.append(body);
  return box;
}

/**
 * One node of a workspace's arrangement, as boxes inside boxes.
 *
 * The same shape the tab has, built from the same tree the tab is built from, so there is one
 * answer to what a workspace looks like rather than two that can disagree. A split becomes a row or
 * a column; a pane becomes the card that was already there.
 *
 * A pane whose session is not in the list is skipped rather than drawn as a gap: it has exited, or
 * it has been taken into another tab and the two facts have not met yet, and either way drawing a
 * hole would be drawing a terminal that is not there.
 */
function buildLayoutNode(
  node: LayoutNode,
  group: SessionGroup,
  options: SessionsOptions,
): HTMLElement | null {
  if (node.type === 'terminal') {
    const session = group.sessions.find((s) => s.sessionId === node.sessionId);
    return session ? buildSessionCard(session, options) : null;
  }
  const first = buildLayoutNode(node.children[0], group, options);
  const second = buildLayoutNode(node.children[1], group, options);
  // One side gone is not a split any more, so the other side stands on its own rather than being
  // drawn as half of something.
  if (!first) return second;
  if (!second) return first;
  const split = document.createElement('div');
  split.className = `session-split is-${node.direction}`;
  split.append(first, second);
  return split;
}

/**
 * One card, exported so a pane offering to take a session shows the same thing.
 *
 * A path is not enough to tell four shells in the same repository apart, and the one you want is
 * the one that printed the thing you remember. That is as true when choosing what to put in a
 * new pane as it is on the start screen, and two renderings of the same idea would drift.
 */
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
