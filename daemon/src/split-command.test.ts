import { describe, expect, it } from 'vitest';
import { splitCommand } from './split-command.js';

/**
 * A settings box is not a shell, and the difference is the whole point of this function.
 *
 * Somebody can type anything into "what should launching an agent run". Passing that to a shell
 * would make `claude; rm -rf ~` a working instruction rather than a typo.
 */
describe('a command line typed by a person', () => {
  it('splits on spaces, which is what argv is', () => {
    expect(splitCommand('claude --model opus')).toEqual(['claude', '--model', 'opus']);
  });

  it('keeps a quoted path together, because paths on a Mac have spaces', () => {
    expect(splitCommand('"/Applications/My Agent/bin/agent" --once')).toEqual([
      '/Applications/My Agent/bin/agent',
      '--once',
    ]);
    expect(splitCommand("agent --say 'hello there'")).toEqual(['agent', '--say', 'hello there']);
  });

  it('treats a shell operator as part of a word rather than as an operator', () => {
    // The result is a program named `claude;`, which does not exist. That is the safe failure.
    expect(splitCommand('claude; rm -rf ~')).toEqual(['claude;', 'rm', '-rf', '~']);
    expect(splitCommand('claude && curl evil.example')).toEqual([
      'claude',
      '&&',
      'curl',
      'evil.example',
    ]);
  });

  it('expands nothing, because a settings box that runs variables is a shell', () => {
    expect(splitCommand('$SHELL')).toEqual(['$SHELL']);
    expect(splitCommand('agent *.ts')).toEqual(['agent', '*.ts']);
  });

  it('collapses whitespace and survives an empty line', () => {
    expect(splitCommand('   claude    --print   ')).toEqual(['claude', '--print']);
    expect(splitCommand('')).toEqual([]);
    expect(splitCommand('    ')).toEqual([]);
  });

  it('keeps an explicitly empty argument, which quotes are the only way to write', () => {
    expect(splitCommand('agent ""')).toEqual(['agent', '']);
  });
});
