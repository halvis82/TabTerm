/**
 * A command line as a person typed it, turned into argv.
 *
 * Here rather than handing the string to a shell, which is the obvious way and is the one thing
 * this must never do. `claude --model opus` and `claude; rm -rf ~` are both strings somebody
 * could type into a settings box, and only the first is a command. Splitting it here means the
 * second is a program called `claude;` that does not exist, which is a harmless error.
 *
 * Quotes are honoured because a path with a space in it is ordinary on a Mac. Nothing else is:
 * no variables, no globs, no operators. A settings box is not a shell and should not pretend.
 */
export function splitCommand(line: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const character of line.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      // An empty pair of quotes is a real, empty argument.
      started = true;
      continue;
    }
    if (character === ' ' || character === '\t') {
      if (current !== '' || started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
  }
  if (current !== '' || started) argv.push(current);
  return argv;
}
