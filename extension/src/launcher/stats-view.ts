import type { CommandTally, PlaceTally, StatsReport } from '@tabterm/shared';
import { formatDuration } from './session-stats.js';
import { formatBytes } from './sessions-view.js';

/**
 * The Stats page.
 *
 * Everything here used to be counted in the page that was showing it, so refreshing the tab reset
 * all of it: a session open all day reported four seconds, no commands and no answers. The numbers
 * were not wrong about the page. They were about the wrong thing, because a tab is a view of a
 * session and the session is what did the work.
 *
 * So it asks the daemon, which sees every command boundary and every agent turn, writes them down,
 * and outlives every tab. This file draws what comes back and knows nothing else.
 */

/** What this tab costs, which only the daemon can measure. Chrome's own side is not reachable. */
export interface SessionCost {
  memoryBytes?: number;
}

const shortPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~');

export function buildStats(report: StatsReport | null, cost: SessionCost = {}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cmd-stats';

  if (report === null) {
    const waiting = document.createElement('div');
    waiting.className = 'cmd-empty';
    waiting.textContent = 'Asking the daemon for what this terminal has done...';
    wrap.append(waiting);
    return wrap;
  }

  /** One group of figures under a heading that says what they are about. */
  const group = (heading: string, figures: [string, string][]): void => {
    if (figures.length === 0) return;
    const title = document.createElement('div');
    title.className = 'cmd-stats-heading';
    title.textContent = heading;
    wrap.append(title);
    const grid = document.createElement('div');
    grid.className = 'cmd-figures';
    for (const [label, value] of figures) {
      const cell = document.createElement('div');
      cell.className = 'cmd-figure';
      const big = document.createElement('div');
      big.className = 'cmd-figure-value';
      big.textContent = value;
      const small = document.createElement('div');
      small.className = 'cmd-figure-label';
      small.textContent = label;
      cell.append(big, small);
      grid.append(cell);
    }
    wrap.append(grid);
  };

  /** A list of things with a count on the right, for the groups that are about habits. */
  const list = (heading: string, rows: [string, string, boolean?][]): void => {
    if (rows.length === 0) return;
    const title = document.createElement('div');
    title.className = 'cmd-stats-heading';
    title.textContent = heading;
    wrap.append(title);
    const box = document.createElement('div');
    box.className = 'cmd-stat-list';
    for (const [text, right, bad] of rows) {
      const row = document.createElement('div');
      row.className = 'cmd-stat-row';
      const what = document.createElement('span');
      what.className = 'cmd-stat-command';
      // Written as text: it is a command somebody ran and has no business being markup.
      what.textContent = text;
      what.title = text;
      const count = document.createElement('span');
      count.className = bad === true ? 'cmd-stat-duration failed' : 'cmd-stat-duration';
      count.textContent = right;
      row.append(what, count);
      box.append(row);
    }
    wrap.append(box);
  };

  const session = report.session;
  if (session) {
    /**
     * Since the session started, which is the whole point of asking the daemon.
     *
     * The agent figures are left out when nothing has been asked here, because a row of zeroes
     * about a feature this terminal is not using is worse than no row at all.
     */
    const figures: [string, string][] = [
      ['Commands run', String(session.commandsRun)],
      ['Failed', String(session.commandsFailed)],
      ['Time in commands', formatDuration(session.commandMs)],
    ];
    if (session.turns > 0) {
      figures.push(['Prompts answered', String(session.turns)]);
      figures.push(['Time waiting on it', formatDuration(session.turnMs)]);
    }
    figures.push(['Open for', formatDuration(Date.now() - session.startedAt)]);
    if (cost.memoryBytes !== undefined && cost.memoryBytes > 0) {
      figures.push(['Memory', formatBytes(cost.memoryBytes)]);
    }
    group('This terminal, since it started', figures);
  }

  const span = (label: string, s: StatsReport['today']): void => {
    const figures: [string, string][] = [
      ['Commands run', String(s.commandsRun)],
      ['Failed', String(s.commandsFailed)],
      ['Terminals opened', String(s.sessionsOpened)],
    ];
    if (s.turns > 0) {
      figures.push(['Prompts answered', String(s.turns)]);
      figures.push(['Waiting on agents', formatDuration(s.turnMs)]);
    }
    figures.push(['Time in commands', formatDuration(s.commandMs)]);
    group(label, figures);
  };
  span('Today', report.today);
  span('The last seven days', report.week);

  list(
    'What you run most',
    report.topCommands.map((c: CommandTally): [string, string] => [
      c.command,
      `${String(c.count)}x`,
    ]),
  );
  list(
    'Where you work',
    report.topPlaces.map((p: PlaceTally): [string, string] => [
      shortPath(p.cwd),
      `${String(p.count)}x`,
    ]),
  );
  list(
    'What went wrong',
    report.failures.map((c: CommandTally): [string, string, boolean] => [
      c.command,
      c.exitCode === undefined ? 'failed' : `exit ${String(c.exitCode)}`,
      true,
    ]),
  );

  /**
   * What is counted, said plainly.
   *
   * An agent CLI is one long-running command, which is why prompts are counted separately: they
   * are the unit that matters in a pane running one, and no command boundary can see them.
   */
  const note = document.createElement('div');
  note.className = 'cmd-stats-note';
  note.textContent =
    'Counts anything run in the foreground and waited for. A job sent to the background with & is ' +
    'not timed, and a command typed with a leading space is not counted at all. Memory is the ' +
    "daemon's side only.";
  wrap.append(note);

  return wrap;
}
