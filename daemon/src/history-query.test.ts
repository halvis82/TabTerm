import { describe, expect, it } from 'vitest';
import { buildWhere, parseHistoryQuery, scopeFilter } from './history-query.js';

const NOW = 1_700_000_000_000;
const parse = (q: string) => parseHistoryQuery(q, NOW);
const labels = (q: string) => parse(q).filters.map((f) => f.label);

describe('history query parsing', () => {
  it('leaves a plain query entirely as text', () => {
    const q = parse('git checkout');
    expect(q.text).toBe('git checkout');
    expect(q.filters).toHaveLength(0);
  });

  it('separates filters from the words around them', () => {
    const q = parse('npm exit:fail test');
    expect(q.text).toBe('npm test');
    expect(labels('npm exit:fail test')).toEqual(['failed']);
  });

  it('understands exit as a word or a code', () => {
    expect(labels('exit:ok')).toEqual(['succeeded']);
    expect(labels('exit:fail')).toEqual(['failed']);
    expect(labels('exit:130')).toEqual(['exit 130']);
  });

  it('understands durations with units and comparisons', () => {
    const q = parse('duration:>2s');
    expect(q.filters[0]?.params).toEqual([2000]);
    expect(parse('duration:<500ms').filters[0]?.params).toEqual([500]);
    expect(parse('duration:1m').filters[0]?.params).toEqual([60_000]);
  });

  it('treats a bare duration as at least that long', () => {
    expect(parse('duration:5s').filters[0]?.sql).toContain('>');
  });

  it('resolves a relative time range against the clock it was given', () => {
    // Passed in rather than read, so this is deterministic.
    expect(parse('since:2d').filters[0]?.params).toEqual([NOW - 2 * 86_400_000]);
    expect(parse('before:1w').filters[0]?.params).toEqual([NOW - 604_800_000]);
  });

  it('matches a project by name, not by absolute path', () => {
    // Nobody types the full repository path into a search box.
    const q = parse('project:tabterm');
    expect(q.filters[0]?.params).toEqual(['tabterm', '%/tabterm']);
  });

  it('matches a directory and everything under it', () => {
    expect(parse('cwd:/a/b').filters[0]?.params).toEqual(['/a/b', '/a/b/%']);
  });

  it('accepts a quoted value, because paths contain spaces', () => {
    expect(parse('cwd:"/a b/c"').filters[0]?.params).toEqual(['/a b/c', '/a b/c/%']);
  });

  it('accepts several filters at once', () => {
    expect(labels('project:app exit:fail since:1d deploy')).toEqual([
      'project app',
      'failed',
      'last 1d',
    ]);
    expect(parse('project:app exit:fail since:1d deploy').text).toBe('deploy');
  });

  it('keeps a half-typed filter as text rather than failing', () => {
    // Someone typing `duration:` has not made an error, they are mid-word.
    for (const q of ['duration:', 'exit:', 'since:', 'duration:abc', 'exit:banana', 'since:soon']) {
      expect(() => parse(q)).not.toThrow();
      expect(parse(q).filters).toHaveLength(0);
    }
  });

  it('keeps an unknown key as text', () => {
    expect(parse('color:red').text).toBe('color:red');
  });

  it('does not treat a URL as a filter', () => {
    expect(parse('curl https://example.com').text).toBe('curl https://example.com');
  });

  it('never puts user text into SQL', () => {
    // The value is always a bound parameter. This is the property that makes a query language
    // in a text box acceptable.
    const q = parse(`cwd:"'; DROP TABLE commands; --"`);
    expect(q.filters[0]?.sql).not.toContain('DROP');
    expect(q.filters[0]?.params[0]).toBe(`'; DROP TABLE commands; --`);
    expect(buildWhere(q.filters).sql).not.toContain('DROP');
  });
});

describe('scopes', () => {
  it('applies nothing for the global scope', () => {
    expect(scopeFilter('global', { gitRoot: '/r' })).toBeNull();
  });

  it('applies a project, directory, or session scope when there is one', () => {
    expect(scopeFilter('project', { gitRoot: '/r' })?.params).toEqual(['/r']);
    expect(scopeFilter('directory', { cwd: '/r/x' })?.params).toEqual(['/r/x']);
    expect(scopeFilter('session', { sessionId: 's1' })?.params).toEqual(['s1']);
  });

  it('falls back to no filter rather than an impossible one', () => {
    // Outside a repository, "this project" has no meaning. Returning a filter that matches
    // nothing would silently show an empty history.
    expect(scopeFilter('project', {})).toBeNull();
    expect(scopeFilter('directory', {})).toBeNull();
  });
});

describe('where building', () => {
  it('ands filters together with their parameters in order', () => {
    const { sql, params } = buildWhere(parse('project:app exit:7').filters);
    expect(sql).toBe(
      '(git_root IS NOT NULL AND (git_root = ? OR git_root LIKE ?)) AND (exit_code = ?)',
    );
    expect(params).toEqual(['app', '%/app', 7]);
  });

  it('produces a harmless clause when there is nothing to filter', () => {
    expect(buildWhere([]).sql).toBe('1 = 1');
  });
});
