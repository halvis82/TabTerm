/**
 * Actions that cross from a webpage into a terminal.
 *
 * The rule the whole file exists to enforce: **text from a webpage never reaches a shell
 * without a person seeing it first.** A page can put anything in a selection, including
 * something that looks like one command and ends in another after a newline, so nothing here
 * ever runs. Everything arrives at a prompt, staged, for the user to read and press Enter on.
 *
 * See docs/05-security.md §4.
 */

export type CrossActionId = 'send-selection' | 'open-url' | 'clone-repo';

export interface CrossAction {
  id: CrossActionId;
  /** Exactly what will appear at the prompt. Never executed by the extension. */
  text: string;
  /** Shown above it, so the user knows where it came from. */
  source: string;
}

/** Control characters, minus the newlines handled separately above. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Strip a selection down to something safe to stage at a prompt.
 *
 * Newlines are the danger: a shell treats one as "run this now", so a selection containing them
 * could execute a second command the moment it lands, before anyone has read it. They are
 * replaced with spaces rather than the text being rejected, because a wrapped command copied
 * out of a webpage is a completely normal thing to want.
 *
 * Other control characters are removed outright. Showing the user what they are about to run is
 * the entire mechanism here, and an escape sequence could make the display disagree with the
 * text.
 */
export function prepareSelection(raw: string): string | null {
  const trimmed = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(CONTROL, '')
    .trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 4000);
}

/** Paths that look like `owner/repo` but are not repositories. */
const RESERVED = new Set([
  'settings',
  'notifications',
  'explore',
  'marketplace',
  'sponsors',
  'orgs',
  'features',
  'pricing',
  'about',
  'search',
]);

/** The git URL a page is a repository at, or null when it is not one. */
export function cloneUrlFor(pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const hosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);
  if (!hosts.has(url.hostname)) return null;

  // owner/repo, ignoring anything deeper such as a file view or a pull request.
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return null;
  if (RESERVED.has(owner)) return null;

  const name = repo.replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return `https://${url.hostname}/${owner}/${name}.git`;
}

/**
 * Build what a menu click should stage at the prompt.
 *
 * Returns a single line with no trailing newline, which is what keeps it staged rather than
 * run. Quoting happens here because these values come from a webpage.
 */
export function buildAction(
  id: CrossActionId,
  input: { selectionText?: string; pageUrl?: string; linkUrl?: string },
): CrossAction | null {
  switch (id) {
    case 'send-selection': {
      const text = input.selectionText ? prepareSelection(input.selectionText) : null;
      return text ? { id, text, source: input.pageUrl ?? 'selection' } : null;
    }

    case 'open-url': {
      const raw = input.linkUrl ?? input.pageUrl;
      if (!raw) return null;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return null;
      }
      // A terminal has no business opening file: or javascript: on a page's say-so.
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      return { id, text: `curl -sSL ${shellQuote(url.toString())} | less`, source: url.origin };
    }

    case 'clone-repo': {
      const clone = cloneUrlFor(input.linkUrl ?? input.pageUrl ?? '');
      return clone ? { id, text: `git clone ${shellQuote(clone)}`, source: clone } : null;
    }
  }
}

/**
 * Single-quote for a POSIX shell.
 *
 * The command is staged rather than run, but it is staged at a real prompt where Enter will run
 * it, so it has to be correct as written. A single-quoted string ends only at the next quote,
 * and `'\''` is the standard way to include one.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
