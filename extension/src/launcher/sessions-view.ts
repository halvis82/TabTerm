import type { LiveSession } from '@tabterm/shared';

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
  return `${String(Math.round(hours / 24))}d ago`;
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
  return 'shell';
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

  for (const session of sessions) {
    grid.append(buildSessionCard(session, options));
  }
  wrap.append(grid);
  return wrap;
}

/**
 * One card, exported so a pane offering to take a session shows the same thing.
 *
 * A path is not enough to tell four shells in the same repository apart, and the one you want is
 * the one that printed the thing you remember. That is as true when choosing what to put in a
 * new pane as it is on the start screen, and two renderings of the same idea would drift.
 */
export function buildSessionCard(session: LiveSession, options: SessionsOptions): HTMLElement {
  const card = document.createElement('article');
  card.className = 'session-card';
  card.dataset['sessionId'] = session.sessionId;
  // The folder it is in, so a right click on the card can act on that folder.
  card.dataset['cwd'] = session.cwd;
  card.tabIndex = 0;
  // Attached and unattached are the whole point of the list, so they differ in more than a word.
  card.dataset['state'] = session.attached ? 'attached' : 'detached';
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
  badge.textContent = session.attached ? 'open in a tab' : 'background';
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
