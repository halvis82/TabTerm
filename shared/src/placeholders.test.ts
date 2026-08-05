import { describe, expect, it } from 'vitest';
import { fillPlaceholders, findPlaceholders, isComplete, sanitizeValue } from './placeholders.js';

describe('finding placeholders', () => {
  it('finds a plain one', () => {
    expect(findPlaceholders('deploy {{env}}')).toEqual([{ name: 'env' }]);
  });

  it('finds a default value', () => {
    expect(findPlaceholders('deploy {{env:staging}}')).toEqual([
      { name: 'env', defaultValue: 'staging' },
    ]);
  });

  it('reports each name once, in the order it appears', () => {
    expect(findPlaceholders('scp {{host}}:{{path}} {{host}}').map((p) => p.name)).toEqual([
      'host',
      'path',
    ]);
  });

  it('tolerates spacing inside the braces', () => {
    expect(findPlaceholders('run {{  name  }}')).toEqual([{ name: 'name' }]);
  });

  it('finds nothing in a command that has none', () => {
    expect(findPlaceholders('npm test')).toEqual([]);
  });

  it('is not confused by shell braces', () => {
    // `${VAR}` and `{a,b}` are shell syntax, not placeholders, and rewriting them would break
    // perfectly good saved commands.
    expect(findPlaceholders('echo ${HOME} && cp a{1,2}.txt /tmp')).toEqual([]);
  });

  it('ignores a name that does not start with a letter', () => {
    expect(findPlaceholders('{{1st}} {{-x}}')).toEqual([]);
  });
});

describe('filling placeholders', () => {
  it('substitutes a value', () => {
    expect(fillPlaceholders('deploy {{env}}', { env: 'prod' })).toBe('deploy prod');
  });

  it('substitutes every occurrence of a name', () => {
    expect(fillPlaceholders('{{h}}:{{h}}', { h: 'x' })).toBe('x:x');
  });

  it('falls back to the default when nothing was given', () => {
    expect(fillPlaceholders('deploy {{env:staging}}', {})).toBe('deploy staging');
  });

  it('prefers a given value over the default', () => {
    expect(fillPlaceholders('deploy {{env:staging}}', { env: 'prod' })).toBe('deploy prod');
  });

  it('leaves an unfilled placeholder visible rather than blanking it', () => {
    // A command that looks complete and is not would be worse than an obviously unfinished one.
    expect(fillPlaceholders('deploy {{env}}', {})).toBe('deploy {{env}}');
    expect(fillPlaceholders('deploy {{env}}', { env: '' })).toBe('deploy {{env}}');
  });

  it('leaves other text untouched', () => {
    expect(fillPlaceholders('echo ${HOME} {{x}}', { x: 'y' })).toBe('echo ${HOME} y');
  });
});

describe('sanitizing a value', () => {
  it('removes line breaks, which would turn one command into two', () => {
    expect(sanitizeValue('a\nb')).toBe('a b');
    expect(sanitizeValue('a\r\nrm -rf ~')).toBe('a rm -rf ~');
  });

  it('removes control characters', () => {
    expect(sanitizeValue('a\u001b[2Kb')).toBe('a[2Kb');
    expect(sanitizeValue('a\u0000b')).toBe('ab');
  });

  it('leaves shell metacharacters alone', () => {
    // The saved command is the user's own, and quoting is their business. Mangling this would
    // break real commands for no security gain, since it is staged and not run.
    expect(sanitizeValue('$(date) && echo "hi"')).toBe('$(date) && echo "hi"');
  });

  it('sanitizes on the way in, so a filled command can never span lines', () => {
    const filled = fillPlaceholders('echo {{msg}}', { msg: 'one\ntwo' });
    expect(filled).toBe('echo one two');
    expect(filled).not.toMatch(/[\r\n]/);
  });

  it('sanitizes a default value too', () => {
    expect(fillPlaceholders('echo {{m:a\nb}}', {})).not.toMatch(/[\r\n]/);
  });
});

describe('knowing when a command is ready', () => {
  it('is complete when there is nothing to fill', () => {
    expect(isComplete('npm test', {})).toBe(true);
  });

  it('is complete once every name has a value', () => {
    expect(isComplete('{{a}} {{b}}', { a: '1', b: '2' })).toBe(true);
  });

  it('is incomplete while a name is missing or empty', () => {
    expect(isComplete('{{a}} {{b}}', { a: '1' })).toBe(false);
    expect(isComplete('{{a}}', { a: '' })).toBe(false);
  });

  it('counts a default as complete, since the command can be staged as written', () => {
    expect(isComplete('{{a:x}}', {})).toBe(true);
  });
});
