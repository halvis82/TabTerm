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
  onClose: (session: LiveSession) => void;
  home: string;
}

const HOME = /^\/Users\/[^/]+/;

export function shortPath(path: string, home: string): string {
  // A template literal starting with ~ is never empty, so home itself renders as plain "~".
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path.replace(HOME, '~');
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

/** What a session is doing, in the fewest words that distinguish it from the others. */
export function describe(session: LiveSession): string {
  if (session.busy) return session.lastCommand ?? session.process ?? 'running';
  if (session.process && session.process !== 'zsh') return session.process;
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
  if (sessions.length > 6) grid.classList.add('is-scrolling');

  for (const session of sessions) {
    grid.append(buildCard(session, options));
  }
  wrap.append(grid);
  return wrap;
}

function buildCard(session: LiveSession, options: SessionsOptions): HTMLElement {
  const card = document.createElement('article');
  card.className = 'session-card';
  card.dataset['sessionId'] = session.sessionId;
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
  title.textContent = shortPath(session.cwd, options.home);
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
   * Rendered as text rather than an image: it stays readable at any zoom, costs nothing to
   * produce, and cannot be a stale picture of a terminal that has since moved on.
   */
  const preview = document.createElement('pre');
  preview.className = 'session-preview';
  preview.textContent =
    session.preview.length > 0 ? session.preview.join('\n') : 'Nothing on screen yet';
  if (session.preview.length === 0) preview.classList.add('is-empty');
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

  const close = document.createElement('button');
  close.className = 'session-close';
  close.title = 'End this session';
  close.textContent = '×';
  close.addEventListener('click', (e) => {
    // Without this the click also opens the session it just ended.
    e.stopPropagation();
    options.onClose(session);
  });
  foot.append(close);

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
