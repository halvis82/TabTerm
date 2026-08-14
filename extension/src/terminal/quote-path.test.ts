import { describe, expect, it } from 'vitest';
import { quotePath } from './quote-path.js';

describe('quoting a path for cd', () => {
  it('leaves a tilde unquoted, or it stops meaning home', () => {
    // `cd '~/Documents'` fails: a quoted tilde is a literal character. This is what made the
    // folder box appear not to work at all, since almost every path typed there starts with ~.
    expect(quotePath('~/Documents')).toBe("~/'Documents'");
    expect(quotePath('~')).toBe('~');
    expect(quotePath('~/')).toBe('~/');
  });

  it('still protects a space further along the path', () => {
    expect(quotePath('~/My Work')).toBe("~/'My Work'");
    expect(quotePath('/Users/someone/My Work')).toBe("'/Users/someone/My Work'");
  });

  it('escapes an apostrophe, which would otherwise end the quoting early', () => {
    expect(quotePath("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(quotePath("~/it's")).toBe("~/'it'\\''s'");
  });

  it('quotes an ordinary absolute path', () => {
    expect(quotePath('/usr/local/bin')).toBe("'/usr/local/bin'");
  });

  it('refuses to let a path break out of the quoting', () => {
    // A folder named after a command substitution must stay a folder name.
    expect(quotePath('/tmp/$(whoami)')).toBe("'/tmp/$(whoami)'");
    expect(quotePath('/tmp/a;rm -rf b')).toBe("'/tmp/a;rm -rf b'");
  });
});
