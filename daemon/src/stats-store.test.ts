import { describe, expect, it } from 'vitest';
import { Database } from './database.js';
import { StatsStore, dayKey, daysBack } from './stats-store.js';

/**
 * Counters that outlive the tab that was looking at them.
 *
 * Everything on the Stats page used to be counted in the page, so a refresh reset it and a session
 * hours old reported four seconds and nothing run. These are the numbers that replace those, and
 * the property that matters is that they are about the session rather than about a view of it.
 */
const store = () => new StatsStore(new Database(':memory:'));

describe('what a session has done', () => {
  it('starts at zero with the session, not with the page', () => {
    const s = store();
    s.sessionStarted('a', 1_000);
    expect(s.forSession('a')).toEqual({
      sessionId: 'a',
      startedAt: 1_000,
      commandsRun: 0,
      commandsFailed: 0,
      commandMs: 0,
      turns: 0,
      turnMs: 0,
    });
  });

  it('keeps the first start, so reattaching does not reset the age', () => {
    // A tab closing and another opening is the case this whole change is about.
    const s = store();
    s.sessionStarted('a', 1_000);
    s.sessionStarted('a', 9_000);
    expect(s.forSession('a')?.startedAt).toBe(1_000);
  });

  it('counts commands, and only a non-zero exit as a failure', () => {
    const s = store();
    s.sessionStarted('a', 0);
    s.commandFinished('a', 500, 0);
    s.commandFinished('a', 1_500, 1);
    // An absent exit code is not a zero and is not a failure either. See ADR-0016.
    s.commandFinished('a', 200);
    const out = s.forSession('a');
    expect(out?.commandsRun).toBe(3);
    expect(out?.commandsFailed).toBe(1);
    expect(out?.commandMs).toBe(2_200);
  });

  it('counts prompts answered, which no command boundary can see', () => {
    // An agent CLI is one command that runs all day, so without this a pane says "1 command".
    const s = store();
    s.sessionStarted('a', 0);
    s.turnFinished('a', 60_000);
    s.turnFinished('a', 30_000);
    expect(s.forSession('a')?.turns).toBe(2);
    expect(s.forSession('a')?.turnMs).toBe(90_000);
  });

  it('says nothing about a session that began before any of this existed', () => {
    expect(store().forSession('never-seen')).toBe(null);
  });

  it('refuses a duration that is not one rather than adding NaN to a total', () => {
    const s = store();
    s.sessionStarted('a', 0);
    s.commandFinished('a', Number.NaN, 0);
    s.turnFinished('a', -5);
    expect(s.forSession('a')?.commandMs).toBe(0);
    expect(s.forSession('a')?.turnMs).toBe(0);
  });
});

describe('what happened over a span of days', () => {
  it('sums the days in the window and treats an absent day as zero', () => {
    const s = store();
    const now = Date.now();
    s.sessionStarted('a', now);
    s.commandFinished('a', 1_000, 0);
    s.commandFinished('a', 1_000, 2);
    s.turnFinished('a', 5_000);

    const today = s.overDays([dayKey(now)]);
    expect(today.commandsRun).toBe(2);
    expect(today.commandsFailed).toBe(1);
    expect(today.turns).toBe(1);
    expect(today.sessionsOpened).toBe(1);

    // A week includes six days nothing happened on, which must read as zero rather than as a gap.
    const week = s.overDays(daysBack(7, now));
    expect(week.commandsRun).toBe(2);
  });

  it('asks in local days, because today is a question about a person', () => {
    // Not UTC: somebody working at 11pm is not asking about tomorrow.
    const noon = new Date(2026, 8, 15, 12, 0, 0).getTime();
    const late = new Date(2026, 8, 15, 23, 30, 0).getTime();
    expect(dayKey(noon)).toBe(dayKey(late));
    expect(dayKey(noon)).toBe('2026-09-15');
  });

  it('counts back from today inclusive', () => {
    const at = new Date(2026, 8, 15, 12, 0, 0).getTime();
    expect(daysBack(3, at)).toEqual(['2026-09-15', '2026-09-14', '2026-09-13']);
  });

  it('drops days older than the window it keeps', () => {
    const s = store();
    const now = Date.now();
    s.sessionStarted('old', now - 400 * 86_400_000);
    s.sessionStarted('new', now);
    s.prune(365, now);
    expect(s.overDays([dayKey(now - 400 * 86_400_000)]).sessionsOpened).toBe(0);
    expect(s.overDays([dayKey(now)]).sessionsOpened).toBe(1);
  });
});
