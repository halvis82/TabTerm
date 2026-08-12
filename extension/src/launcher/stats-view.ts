import { formatDuration, formatTime, type SessionStats } from './session-stats.js';

/**
 * The Stats tab.
 *
 * What this session has run, how long each took, and when. Reading a session back is most useful
 * when something was slow, so duration and time are the two columns that never get truncated.
 */
export function buildStats(stats: SessionStats): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cmd-stats';

  const summary = stats.summarize();
  const figures: [label: string, value: string][] = [
    ['Commands', String(summary.total)],
    ['Failed', String(summary.failed)],
    ['Running', String(summary.running)],
    ['Median', formatDuration(summary.medianMs)],
    ['Total time', formatDuration(summary.totalMs)],
    ['Session started', formatTime(summary.startedAt)],
  ];

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

  if (summary.longest) {
    const longest = document.createElement('div');
    longest.className = 'cmd-note';
    longest.textContent = `Longest: ${summary.longest.command} (${formatDuration(summary.longest.durationMs)})`;
    wrap.append(longest);
  }

  const list = document.createElement('div');
  list.className = 'cmd-stat-list';
  const records = stats.records;

  if (records.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent =
      'Nothing timed yet. Commands appear here as you run them, with how long each took.';
    wrap.append(empty);
    return wrap;
  }

  for (const record of records.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'cmd-stat-row';
    if ((record.exitCode ?? 0) !== 0 && record.durationMs !== undefined) {
      row.classList.add('failed');
    }

    const time = document.createElement('span');
    time.className = 'cmd-stat-time';
    time.textContent = formatTime(record.startedAt);

    const command = document.createElement('span');
    command.className = 'cmd-stat-command';
    command.textContent = record.command;
    command.title = record.command;

    const duration = document.createElement('span');
    duration.className = 'cmd-stat-duration';
    duration.textContent = formatDuration(record.durationMs);

    row.append(time, command, duration);
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}
