/**
 * Which start screen sections a person has folded, kept across tabs and restarts.
 *
 * A fold is a decision about how somebody wants their own screen to look, and having to make it
 * again in every tab is the same as not having made it. Extension storage rather than the daemon,
 * because it describes a view rather than anything the daemon owns, which is where the templates
 * and the custom actions live for the same reason.
 *
 * Written on change and read once when the launcher is built. Failing to store a fold is not worth
 * an error: the section opens, which is the state it would have had anyway.
 */
const KEY = 'tabterm.sections.folded';

/**
 * What can be folded.
 *
 * The named ones are the sections. The `port:` ones are a group inside the ports section, one per
 * program holding a port, and their names come from the machine rather than from here: a person
 * with a program this list has never heard of should still be able to fold its group. So the type
 * is open at that one prefix and closed everywhere else.
 */
export type FoldableSection =
  'otherPorts' | 'recentFolders' | 'resumeAgent' | 'reopenRestart' | `port:${string}`;

const NAMED = new Set(['otherPorts', 'recentFolders', 'resumeAgent', 'reopenRestart']);

/** The fold key for one program's group of ports. */
export function portGroupKey(program: string): FoldableSection {
  return `port:${program}`;
}

/**
 * The sections folded right now. Anything unrecognised is ignored rather than trusted.
 *
 * Storage outlives this version, so what is read is not necessarily what this version wrote. A
 * fold is a view preference and the safe answer to a name nobody knows is to show the section.
 */
export function parseFolded(raw: unknown): Set<FoldableSection> {
  const out = new Set<FoldableSection>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw as readonly unknown[]) {
    if (typeof item !== 'string') continue;
    if (NAMED.has(item)) out.add(item as FoldableSection);
    // A program name can be anything, but the shape of the key cannot.
    else if (item.startsWith('port:') && item.length > 'port:'.length) {
      out.add(item as FoldableSection);
    }
  }
  return out;
}

export async function loadFolded(): Promise<Set<FoldableSection>> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return parseFolded(stored[KEY]);
  } catch {
    return new Set();
  }
}

export async function saveFolded(folded: ReadonlySet<FoldableSection>): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: [...folded] });
  } catch {
    // A fold that could not be stored is worth less than the start screen still drawing.
  }
}
