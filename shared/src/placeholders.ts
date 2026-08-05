/**
 * Placeholder variables in a saved command.
 *
 * A saved command is only worth keeping if it can be reused somewhere slightly different, so
 * `deploy {{env}}` should ask what `env` is rather than being copied and edited every time.
 *
 * Filling one in is **text substitution into a string that is then staged at a prompt**, never
 * into anything that executes. The value a user types is their own, but it still ends up on a
 * line where Enter runs it, so line breaks are removed: a value containing one could turn a
 * single command into two. See docs/05-security.md §4.
 */

/** `{{name}}`, or `{{name:default}}`. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w-]*)\s*(?::([^}]*))?\}\}/g;

export interface Placeholder {
  name: string;
  defaultValue?: string;
}

/** Every distinct placeholder, in the order it first appears. */
export function findPlaceholders(body: string): Placeholder[] {
  const seen = new Map<string, Placeholder>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!name || seen.has(name)) continue;
    const defaultValue = match[2]?.trim();
    seen.set(name, defaultValue ? { name, defaultValue } : { name });
  }
  return [...seen.values()];
}

/**
 * Substitute values in.
 *
 * A name with no value keeps its placeholder rather than becoming an empty string. Silently
 * dropping it would produce a command that looks complete and is not, which is the one outcome
 * worse than an obviously unfinished one.
 */
export function fillPlaceholders(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(PLACEHOLDER, (whole, rawName: string, rawDefault?: string) => {
    const provided = values[rawName.trim()];
    if (provided !== undefined && provided !== '') return sanitizeValue(provided);
    const fallback = rawDefault?.trim();
    if (fallback) return sanitizeValue(fallback);
    return whole;
  });
}

/**
 * A placeholder value can hold anything except a line break.
 *
 * The filled command is staged at a prompt where Enter runs it, so a newline would turn one
 * command into two. Everything else is left alone: quoting is the user's business in their own
 * saved command, and mangling their text would break real commands.
 */
export function sanitizeValue(value: string): string {
  return (
    value
      .replace(/[\r\n]+/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  );
}

/** Whether every placeholder has a value or a default, so the command is ready to stage. */
export function isComplete(body: string, values: Readonly<Record<string, string>>): boolean {
  return findPlaceholders(body).every(
    (p) => p.defaultValue !== undefined || (values[p.name] ?? '') !== '',
  );
}
