/**
 * What somebody means by what they typed into the folder box.
 *
 * A bare name means home. Typing `Documents` means `~/Documents`, because that is what a person
 * means when they type it and asking them to write `~/` first is asking them to say something
 * everybody already assumes. A leading `/` means the root, which is the one case where the
 * literal reading is the intended one.
 *
 * The `~/` is **never inserted into the box**. Prefixing as they type would fight the cursor, and
 * a box that rewrites what you are typing is worse than one that needs a prefix. It is assumed
 * everywhere the value is used instead: opening, completing, and browsing all go through here, so
 * Tab completes `Documents` as though it read `~/Documents` without ever showing that.
 */
export function resolveTypedPath(typed: string, home: string): string {
  const text = typed.trim();
  if (text === '') return home;
  // Absolute, and a tilde the person wrote themselves, are both taken literally.
  if (text.startsWith('/') || text.startsWith('~')) return text;
  return `~/${text}`;
}

/**
 * The reverse, for showing an answer back in the box.
 *
 * A completion comes back as a full path and has to be put where it came from: if they typed
 * `Doc` they should see `Documents`, not `~/Documents`. Only the prefix this file added is
 * removed, so a path they wrote with a tilde keeps it.
 */
export function unresolveTypedPath(full: string, typed: string): string {
  const text = typed.trim();
  if (text.startsWith('/') || text.startsWith('~') || text === '') return full;
  return full.startsWith('~/') ? full.slice(2) : full;
}
