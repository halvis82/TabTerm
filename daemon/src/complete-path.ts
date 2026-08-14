import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Directory completion, as a shell does it.
 *
 * The launcher's folder box asks for this because a browser page cannot read a disk, and the
 * alternative, running a real shell to find out what somebody is about to type, means executing
 * something on every keystroke.
 *
 * Directories only. The box opens a terminal in a folder, so offering files would be offering
 * something that cannot be chosen.
 */

/** Enough to show, few enough to render. A directory of thousands is not a menu. */
const MAX_MATCHES = 50;

export interface PathCompletion {
  completed: string;
  matches: string[];
}

/** The longest prefix every candidate shares, which is exactly what Tab fills in. */
export function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] ?? '';
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/** Put `~` back, so what is shown matches what was typed. */
export function contractHome(path: string, home = homedir()): string {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function completePath(partial: string, home = homedir()): PathCompletion {
  const expanded = expandHome(partial, home);

  // Split into the directory being listed and the fragment being matched. A trailing slash means
  // the directory itself is complete and everything in it is a candidate.
  const cut = expanded.lastIndexOf('/');
  const directory = cut <= 0 ? (cut === 0 ? '/' : expanded || '.') : expanded.slice(0, cut);
  const fragment = cut === -1 ? expanded : expanded.slice(cut + 1);

  let entries: string[];
  try {
    if (!existsSync(directory)) return { completed: partial, matches: [] };
    entries = readdirSync(directory);
  } catch {
    // Unreadable, which for a completion is the same as having nothing to offer.
    return { completed: partial, matches: [] };
  }

  const matches: string[] = [];
  for (const name of entries) {
    // Hidden entries only when they are being asked for, the way a shell behaves.
    if (name.startsWith('.') && !fragment.startsWith('.')) continue;
    if (!name.startsWith(fragment)) continue;
    try {
      if (!statSync(join(directory, name)).isDirectory()) continue;
    } catch {
      continue; // A symlink to nowhere, or something that vanished mid-listing.
    }
    matches.push(name);
    if (matches.length > MAX_MATCHES) break;
  }

  if (matches.length === 0) return { completed: partial, matches: [] };

  const shared = commonPrefix(matches);
  const base = directory === '/' ? '/' : `${directory}/`;
  // A single match completes to a trailing slash, which is what lets the next Tab go deeper.
  const completedAbsolute = `${base}${shared}${matches.length === 1 ? '/' : ''}`;
  return { completed: contractHome(completedAbsolute, home), matches: matches.sort() };
}
