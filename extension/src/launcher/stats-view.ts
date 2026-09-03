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
  /**
   * Labels that say what the number is.
   *
   * `Median` and `Total time` were both ambiguous: the first named a statistic rather than a
   * meaning, and the second could as easily have been the age of the session as the sum of the
   * commands. The statistic itself is unchanged and the reason is still good, so it is the words
   * that changed.
   */
  const figures: [label: string, value: string][] = [
    ['Commands run', String(summary.total)],
    ['Failed', String(summary.failed)],
    ['Running now', String(summary.running)],
    // The median, not the mean: one `npm install` should not describe a session of quick
    // commands, which is exactly what an average does.
    ['Typical command', formatDuration(summary.medianMs)],
    ['Time in commands', formatDuration(summary.totalMs)],
    ['Session open', formatDuration(Date.now() - summary.startedAt)],
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

  /**
   * What is counted, said plainly.
   *
   * The honest answer to "do agents count, and servers, and background jobs?" is: whatever the
   * shell reports as a command, which is everything run in the foreground and waited for. An
   * agent CLI and a dev server are each one long-running command and show under `Running now`
   * until they stop. Anything sent to the background with `&` is not the foreground process and
   * is not timed, because nothing marks when it ends.
   */
  const note = document.createElement('div');
  note.className = 'cmd-stats-note';
  note.textContent =
    'Counts anything run in the foreground and waited for, agents and servers included. ' +
    'A job sent to the background with & is not timed.';
  wrap.append(note);

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
