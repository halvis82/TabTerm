import { describe, expect, it } from 'vitest';
import { quotePath } from './quote-path.js';

describe('quoting a path for cd', () => {
  it('leaves a tilde unquoted, or it stops meaning home', () => {
    // `cd '~/Documents'` fails: a quoted tilde is a literal character. This is what made the
    // folder box appear not to work at all, since almost every path typed there starts with ~.
    expect(quotePath('~')).toBe('~');
    expect(quotePath('~/')).toBe('~/');
  });

  it('does not quote a path that does not need it', () => {
    /**
     * The line goes into the scrollback and is read later. `cd ~/'Documents/thing'` for a folder
     * with no space in it is a line nobody would have typed, and it made the folder box look
     * like it was doing something clever when it was only opening a directory.
     */
    expect(quotePath('~/Documents')).toBe('~/Documents');
    expect(quotePath('~/Documents/personal_coding/wifi-site-blocker/')).toBe(
      '~/Documents/personal_coding/wifi-site-blocker/',
    );
    expect(quotePath('/usr/local/bin')).toBe('/usr/local/bin');
    expect(quotePath('~/a-b.c+d,e:f@g%h=i')).toBe('~/a-b.c+d,e:f@g%h=i');
  });

  it('still protects a space further along the path', () => {
    expect(quotePath('~/My Work')).toBe("~/'My Work'");
    expect(quotePath('/Users/someone/My Work')).toBe("'/Users/someone/My Work'");
  });

  it('escapes an apostrophe, which would otherwise end the quoting early', () => {
    expect(quotePath("/tmp/it's")).toBe("'/tmp/it'\\''s'");
    expect(quotePath("~/it's")).toBe("~/'it'\\''s'");
  });

  it('refuses to let a path break out of the quoting', () => {
    // A folder named after a command substitution must stay a folder name.
    expect(quotePath('/tmp/$(whoami)')).toBe("'/tmp/$(whoami)'");
    expect(quotePath('/tmp/a;rm -rf b')).toBe("'/tmp/a;rm -rf b'");
    expect(quotePath('~/`whoami`')).toBe("~/'`whoami`'");
    expect(quotePath('~/*')).toBe("~/'*'");
    expect(quotePath('~/a&b')).toBe("~/'a&b'");
    expect(quotePath('~/a\nb')).toBe("~/'a\nb'");
  });

  it('quotes anything it was not told is safe, rather than guessing', () => {
    // The list is of what passes through untouched, so a character nobody thought of is quoted.
    expect(quotePath('~/héllo')).toBe("~/'héllo'");
  });
});
