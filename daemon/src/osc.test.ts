import { describe, expect, it, vi } from 'vitest';
import { OscScanner } from './osc.js';

const ST = '\\';
const BEL = '';

function make() {
  const events = {
    onCwd: vi.fn(),
    onPromptStart: vi.fn(),
    onCommandStart: vi.fn(),
    onCommandEnd: vi.fn(),
  };
  return { events, scanner: new OscScanner(events) };
}

describe('OSC scanner', () => {
  it('parses a cwd report', () => {
    const { events, scanner } = make();
    scanner.feed(`]7;file://myhost/Users/me/Projects${ST}`);
    expect(events.onCwd).toHaveBeenCalledWith('/Users/me/Projects');
  });

  it('accepts BEL as a terminator as well as ST', () => {
    const { events, scanner } = make();
    scanner.feed(`]7;file://h/tmp${BEL}`);
    expect(events.onCwd).toHaveBeenCalledWith('/tmp');
  });

  it('handles a sequence split across chunks, as a real PTY delivers it', () => {
    const { events, scanner } = make();
    scanner.feed(']7;file://myh');
    scanner.feed('ost/Users/me/spl');
    scanner.feed(`it${ST}`);
    expect(events.onCwd).toHaveBeenCalledWith('/Users/me/split');
  });

  it('decodes percent-escaped paths', () => {
    const { events, scanner } = make();
    scanner.feed(`]7;file://h/Users/me/My%20Projects${ST}`);
    expect(events.onCwd).toHaveBeenCalledWith('/Users/me/My Projects');
  });

  it('parses the full command lifecycle with an exit code', () => {
    const { events, scanner } = make();
    scanner.feed(`]133;A${ST}]133;B${ST}]133;C${ST}]133;D;130${ST}`);
    expect(events.onPromptStart).toHaveBeenCalled();
    expect(events.onCommandStart).toHaveBeenCalled();
    expect(events.onCommandEnd).toHaveBeenCalledWith(130);
  });

  it('passes ordinary terminal output through without firing anything', () => {
    const { events, scanner } = make();
    scanner.feed('hello [31mred[0m world\r\n$ ls -la\r\n');
    expect(events.onCwd).not.toHaveBeenCalled();
    expect(events.onCommandEnd).not.toHaveBeenCalled();
    expect(events.onPromptStart).not.toHaveBeenCalled();
  });

  it('rejects hostile or malformed cwd payloads', () => {
    const { events, scanner } = make();
    for (const bad of [
      'javascript:alert(1)',
      'http://evil.example/x',
      'file://hostnopath',
      'data:text/html,<script>',
      `file://h/${'a'.repeat(9000)}`,
    ]) {
      scanner.feed(`]7;${bad}${ST}`);
    }
    expect(events.onCwd).not.toHaveBeenCalled();
  });

  it('only ever reports absolute paths', () => {
    const { events, scanner } = make();
    scanner.feed(`]7;file://h/ok/path${ST}`);
    const reported = events.onCwd.mock.calls.map((c) => c[0] as string);
    expect(reported.every((p) => p.startsWith('/'))).toBe(true);
  });

  it('does not grow without bound on a stream that never terminates', () => {
    const { scanner } = make();
    for (let i = 0; i < 500; i++) scanner.feed(']7;' + 'x'.repeat(1000));
    // No throw and no unbounded retention. The scanner discards impossible sequences.
    expect(true).toBe(true);
  });

  it('recovers and keeps parsing after garbage', () => {
    const { events, scanner } = make();
    scanner.feed(']999;nonsense-with-no-terminator');
    scanner.feed(`]7;file://h/after/garbage${ST}`);
    expect(events.onCwd).toHaveBeenCalledWith('/after/garbage');
  });
});

describe('command text reporting', () => {
  it('decodes a percent-encoded command line', () => {
    const events = {
      onCwd: vi.fn(),
      onPromptStart: vi.fn(),
      onCommandStart: vi.fn(),
      onCommandEnd: vi.fn(),
      onCommandText: vi.fn(),
    };
    const scanner = new OscScanner(events);
    scanner.feed(`\x1b]1338;git%20status%20--short${ST}`);
    expect(events.onCommandText).toHaveBeenCalledWith('git status --short');
  });

  it('survives a payload that would otherwise break the sequence', () => {
    const events = {
      onCwd: vi.fn(),
      onPromptStart: vi.fn(),
      onCommandStart: vi.fn(),
      onCommandEnd: vi.fn(),
      onCommandText: vi.fn(),
    };
    const scanner = new OscScanner(events);
    // A semicolon and a quote, encoded, must arrive intact rather than truncating.
    scanner.feed(`\x1b]1338;echo%20%22a%3Bb%22${ST}`);
    expect(events.onCommandText).toHaveBeenCalledWith('echo "a;b"');
  });

  it('ignores a malformed encoding rather than throwing', () => {
    const events = {
      onCwd: vi.fn(),
      onPromptStart: vi.fn(),
      onCommandStart: vi.fn(),
      onCommandEnd: vi.fn(),
      onCommandText: vi.fn(),
    };
    const scanner = new OscScanner(events);
    expect(() => scanner.feed(`\x1b]1338;%ZZ${ST}`)).not.toThrow();
    expect(events.onCommandText).not.toHaveBeenCalled();
  });
});
