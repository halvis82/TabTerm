/**
 * A turn of a stored conversation, as a person would read it in a list.
 *
 * What is in the file is what the agent was sent and what it sent back: markdown, tables written
 * with pipes, fenced code, and machinery that is not conversation at all. Flattened into one line
 * for a row in a list, that came out as noise. Reported with a picture of it: rows of
 * `<task-notification> <task-id>… </task-notification>`, and a paragraph whose middle was a table
 * rendered as `| 8 | 52.0, 46.0, 42.3 | **9.7 points** | | 15 |`.
 *
 * The point of these rows is telling one session from another, so what belongs in them is the
 * sentences. Everything here removes something that is formatting or plumbing, and nothing here
 * invents anything: a turn that is only machinery becomes empty and is dropped by the caller
 * rather than shown as a blank row.
 */

/**
 * Wrappers a turn can be made entirely of, none of which a person typed or an agent said.
 *
 * Their contents are as machine-facing as their tags: a monitor firing, a slash command being
 * echoed, the output of one being pasted back in. A row of any of them says nothing about what
 * the session was about.
 */
const MACHINERY = [
  'task-notification',
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'user-prompt-submit-hook',
];

/** Whether this turn is one of those wrappers and nothing else worth reading. */
export function isMachinery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  for (const tag of MACHINERY) {
    if (!trimmed.startsWith(`<${tag}`)) continue;
    // What is left once the wrapper and its contents are gone. A turn that is only the wrapper is
    // machinery; one that has a sentence beside it is a person writing with a notification pasted
    // in, and the sentence is worth keeping.
    const without = trimmed
      .split(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'g'))
      .join(' ')
      .trim();
    if (without === '') return true;
  }
  return false;
}

/**
 * The readable text of a turn: the sentences, without the marks that arrange them.
 *
 * Markdown is left as its own text rather than rendered, because this is one line in a list and
 * there is nowhere to render it to. `**not stable**` reads perfectly well as `not stable`, and the
 * stars only cost room and attention.
 */
export function readableTurn(text: string): string {
  let out = text;

  // The machinery, wherever it sits, including when a sentence is written around it.
  for (const tag of MACHINERY) {
    out = out.split(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'g')).join(' ');
  }

  out = out
    // Fenced code, which is never a sentence and is often most of a turn.
    .replace(/```[\s\S]*?```/g, ' (code) ')
    // A table's rule, which is punctuation holding up columns that are not drawn here anyway.
    .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, ' ')
    // And its cells, joined the way a sentence joins things.
    .replace(/[ \t]*\|[ \t]*/g, ' · ')
    // Headings, bullets and quotes: the line is what matters, not what it is dressed as.
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '· ')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    // Emphasis, kept as the words it was emphasising.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // A link, kept as its words rather than its address.
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    // Anything else in angle brackets that is plainly a tag rather than a comparison.
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, ' ');

  return (
    out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(/(?:·\s*){2,}/g, '· ')
      // A table's last cell leaves a separator with nothing after it, and its first leaves one with
      // nothing before it. Both are the edge of a table that is not being drawn.
      .replace(/^[·\s]+/, '')
      .replace(/[·\s]+$/, '')
      .trim()
  );
}
