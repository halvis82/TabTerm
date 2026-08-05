/**
 * The history query language.
 *
 * Parsing is separate from running the query, and produces parameterized SQL fragments that a
 * caller binds. No user text ever reaches a SQL string: the filters below decide the column and
 * the operator, and every value they extract becomes a bound parameter. That is the property
 * that makes accepting a query language from a text box reasonable at all.
 *
 * Anything unrecognized stays in the free-text part rather than being reported as an error. A
 * history box is somewhere people type fragments, and `duration:` half typed should narrow the
 * text, not throw. See docs/03-data-model.md and docs/08-launcher.md.
 */

export type Scope = 'global' | 'project' | 'directory' | 'session';

export interface HistoryQuery {
  /** What is left after the filters are taken out, matched as a fuzzy subsequence. */
  text: string;
  filters: Filter[];
}

export interface Filter {
  /** SQL with `?` placeholders, ANDed with the rest. */
  sql: string;
  params: (string | number)[];
  /** For showing the user what is actually being applied. */
  label: string;
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const AGE_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Split a query into filters and free text.
 *
 * `now` is passed in rather than read, so a relative time range is deterministic and testable.
 */
export function parseHistoryQuery(input: string, now: number): HistoryQuery {
  const filters: Filter[] = [];
  const words: string[] = [];

  for (const token of tokenize(input)) {
    const filter = toFilter(token, now);
    if (filter) filters.push(filter);
    else words.push(token);
  }
  return { text: words.join(' ').trim(), filters };
}

/** Quoted values hold spaces, which paths regularly do. */
function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /[^\s"]*"[^"]*"|[^\s]+/g;
  for (const m of input.matchAll(re)) out.push(m[0]);
  return out;
}

function toFilter(token: string, now: number): Filter | null {
  const at = token.indexOf(':');
  if (at <= 0) return null;
  const key = token.slice(0, at).toLowerCase();
  const raw = unquote(token.slice(at + 1));
  if (!raw) return null;

  switch (key) {
    case 'project':
    case 'repo':
      // Matched on the basename, because nobody types an absolute repository path.
      return {
        sql: 'git_root IS NOT NULL AND (git_root = ? OR git_root LIKE ?)',
        params: [raw, `%/${raw}`],
        label: `project ${raw}`,
      };

    case 'cwd':
    case 'dir':
      return { sql: '(cwd = ? OR cwd LIKE ?)', params: [raw, `${raw}/%`], label: `in ${raw}` };

    case 'exit': {
      if (raw === 'ok' || raw === '0') {
        return { sql: 'exit_code = 0', params: [], label: 'succeeded' };
      }
      if (raw === 'fail' || raw === 'failed' || raw === 'error') {
        return { sql: 'exit_code IS NOT NULL AND exit_code != 0', params: [], label: 'failed' };
      }
      const code = Number(raw);
      if (!Number.isInteger(code)) return null;
      return { sql: 'exit_code = ?', params: [code], label: `exit ${String(code)}` };
    }

    case 'duration': {
      const cmp = comparison(raw, DURATION_UNITS);
      if (!cmp) return null;
      return {
        sql: `duration_ms IS NOT NULL AND duration_ms ${cmp.op} ?`,
        params: [cmp.value],
        label: `ran ${cmp.op} ${raw}`,
      };
    }

    case 'host':
      // Recorded for remote sessions. Absent locally, so this deliberately excludes local rows
      // rather than matching everything when the column is null.
      return { sql: 'ssh_host = ?', params: [raw], label: `on ${raw}` };

    case 'since': {
      const ms = age(raw);
      if (ms === null) return null;
      return { sql: 'last_used_at >= ?', params: [now - ms], label: `last ${raw}` };
    }

    case 'before': {
      const ms = age(raw);
      if (ms === null) return null;
      return { sql: 'last_used_at < ?', params: [now - ms], label: `before ${raw} ago` };
    }

    default:
      return null;
  }
}

/** `>500ms`, `<2s`, `>=1m`, or a bare value meaning "at least". */
function comparison(
  raw: string,
  units: Record<string, number>,
): { op: '>' | '<' | '>=' | '<='; value: number } | null {
  const m = /^(>=|<=|>|<)?\s*(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(raw);
  if (!m?.[2]) return null;
  const unit = m[3] ? units[m[3]] : units['ms'];
  if (unit === undefined) return null;
  const op = (m[1] ?? '>') as '>' | '<' | '>=' | '<=';
  return { op, value: Math.round(Number(m[2]) * unit) };
}

function age(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(raw.toLowerCase());
  if (!m?.[1] || !m[2]) return null;
  const unit = AGE_UNITS[m[2]];
  return unit === undefined ? null : Math.round(Number(m[1]) * unit);
}

function unquote(v: string): string {
  return v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v;
}

/**
 * A scope is a filter the UI applies, not something the user types.
 *
 * It exists so "only this project" is one click rather than a remembered path.
 */
export function scopeFilter(
  scope: Scope,
  context: { gitRoot?: string; cwd?: string; sessionId?: string },
): Filter | null {
  switch (scope) {
    case 'project':
      return context.gitRoot
        ? { sql: 'git_root = ?', params: [context.gitRoot], label: 'this project' }
        : null;
    case 'directory':
      return context.cwd
        ? { sql: 'cwd = ?', params: [context.cwd], label: 'this directory' }
        : null;
    case 'session':
      return context.sessionId
        ? { sql: 'session_id = ?', params: [context.sessionId], label: 'this session' }
        : null;
    case 'global':
      return null;
  }
}

/** Combine filters into a WHERE clause and its parameters, in matching order. */
export function buildWhere(filters: readonly Filter[]): {
  sql: string;
  params: (string | number)[];
} {
  if (filters.length === 0) return { sql: '1 = 1', params: [] };
  return {
    sql: filters.map((f) => `(${f.sql})`).join(' AND '),
    params: filters.flatMap((f) => f.params),
  };
}
