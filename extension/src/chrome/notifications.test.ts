import { describe, expect, it, vi } from 'vitest';
import {
  clearNotificationsFor,
  notify,
  shouldNotify,
  type NotifyRequest,
} from './notifications.js';

const req = (over: Partial<NotifyRequest> = {}): NotifyRequest => ({
  priority: 'important',
  title: 'Terminal',
  body: 'something happened',
  ...over,
});

describe('notification policy', () => {
  it('never raises a desktop notification for a low priority event', () => {
    // A short command finishing or a shell going idle is what makes people turn notifications
    // off entirely. Those states belong in the favicon and the title.
    expect(shouldNotify(req({ priority: 'low' }), false)).toBe(false);
    expect(shouldNotify(req({ priority: 'low' }), true)).toBe(false);
  });

  it('raises important and critical events when nothing is on screen', () => {
    expect(shouldNotify(req({ priority: 'important' }), false)).toBe(true);
    expect(shouldNotify(req({ priority: 'critical' }), false)).toBe(true);
  });

  it('stays quiet when the pane is already visible and asked to', () => {
    expect(shouldNotify(req({ suppressIfVisible: true }), true)).toBe(false);
  });

  it('still notifies a visible pane when suppression was not requested', () => {
    expect(shouldNotify(req({ suppressIfVisible: false }), true)).toBe(true);
    expect(shouldNotify(req(), true)).toBe(true);
  });

  it('does not let visibility silence a critical event unless explicitly asked', () => {
    // Something needing permission is worth interrupting for, even on screen.
    expect(shouldNotify(req({ priority: 'critical' }), true)).toBe(true);
  });
});

/**
 * A notification interrupts once, and is then taken back.
 *
 * Every one of them used to stay until it was clicked, so a day of finished commands became a
 * list somebody had to clear. Chrome has no "show it but do not keep it", so the nearest thing
 * is to withdraw it, which is what clicking would have done.
 */
describe('taking a notification back', () => {
  const withFakeChrome = async (
    priority: NotifyRequest['priority'],
    run: (cleared: string[]) => Promise<void>,
  ) => {
    const cleared: string[] = [];
    const created: string[] = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { getURL: (p: string) => p, lastError: undefined },
      notifications: {
        create: (id: string, _options: unknown, done: () => void) => {
          created.push(id);
          done();
        },
        clear: (id: string) => cleared.push(id),
      },
    };
    vi.useFakeTimers();
    try {
      await notify({ priority, title: 'Terminal', body: 'done' });
      vi.advanceTimersByTime(30_000);
      await run(cleared);
    } finally {
      vi.useRealTimers();
    }
  };

  it('withdraws an ordinary one once it has been seen', async () => {
    await withFakeChrome('important', async (cleared) => {
      expect(cleared).toHaveLength(1);
      return Promise.resolve();
    });
  });

  it('leaves a critical one alone, because that is what critical means', async () => {
    // It is raised with requireInteraction, so it stays until somebody deals with it. Taking it
    // away on a timer would remove the only thing that distinguishes it.
    await withFakeChrome('critical', async (cleared) => {
      expect(cleared).toHaveLength(0);
      return Promise.resolve();
    });
  });
});

/**
 * A notification that can take you somewhere stays until it has.
 *
 * The eight second withdrawal was right about a day of finished commands becoming a list, and
 * wrong about the case it was there for: an agent finishing while somebody is in another
 * application produced a notice that was gone before they looked, so the thing they were told
 * about was never told to them at all.
 */
describe('a notification that points at a tab', () => {
  /** Enough of Chrome to answer the three questions these checks ask. */
  const fakeChrome = () => {
    const cleared: string[] = [];
    const options: Record<string, unknown>[] = [];
    const ids: string[] = [];
    let stored: Record<string, unknown> = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { getURL: (p: string) => p, lastError: undefined },
      notifications: {
        create: (id: string, opts: Record<string, unknown>, done: () => void) => {
          ids.push(id);
          options.push(opts);
          done();
        },
        clear: (id: string) => cleared.push(id),
      },
      storage: {
        session: {
          get: (key: string) => Promise.resolve({ [key]: stored[key] }),
          set: (values: Record<string, unknown>) => {
            stored = { ...stored, ...values };
            return Promise.resolve();
          },
        },
      },
    };
    return { cleared, options, ids };
  };

  const target = { workspaceId: 'ws-1' };

  it('is not withdrawn on a timer', async () => {
    const { cleared } = fakeChrome();
    vi.useFakeTimers();
    try {
      await notify({ priority: 'important', title: 'Agent', body: 'done', target });
      vi.advanceTimersByTime(300_000);
      expect(cleared).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * One notice per tab, replaced rather than stacked.
   *
   * Three commands finishing in one terminal used to be three notices, and a morning of them was
   * a column to clear by hand. The id is the workspace, so Chrome updates the one that tab
   * already has. Reported as: "i see a lot of stale ones ... only one notification at most per
   * tab".
   */
  it('reuses one id per tab, so a new one replaces the one before it', async () => {
    const { ids } = fakeChrome();
    await notify({ priority: 'important', title: 'Agent', body: 'first', target });
    await notify({ priority: 'important', title: 'Agent', body: 'second', target });
    await notify({ priority: 'important', title: 'Agent', body: 'third', target });
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toContain('ws-1');
  });

  it('and a different tab gets its own', async () => {
    const { ids } = fakeChrome();
    await notify({ priority: 'important', title: 'Agent', body: 'one', target });
    await notify({
      priority: 'important',
      title: 'Agent',
      body: 'two',
      target: { workspaceId: 'ws-2' },
    });
    expect(new Set(ids).size).toBe(2);
  });

  /*
   * And one with no tab behind it keeps an id of its own: there is nothing to replace, nothing to
   * go to, and these are the ones withdrawn on a timer instead.
   */
  it('while a notice with no tab is not folded into anything', async () => {
    const { ids } = fakeChrome();
    await notify({ priority: 'important', title: 'tabtermd', body: 'one' });
    await notify({ priority: 'important', title: 'tabtermd', body: 'two' });
    expect(new Set(ids).size).toBe(2);
  });

  it('is withdrawn when its workspace is reached', async () => {
    const { cleared } = fakeChrome();
    await notify({ priority: 'important', title: 'Agent', body: 'done', target });
    await clearNotificationsFor('ws-1');
    expect(cleared).toHaveLength(1);
  });

  it('leaves other workspaces alone', async () => {
    const { cleared } = fakeChrome();
    await notify({ priority: 'important', title: 'Agent', body: 'done', target });
    await clearNotificationsFor('ws-2');
    expect(cleared).toEqual([]);
  });

  it('says that clicking opens the tab', async () => {
    // Clicking has always done this and nothing on the notification admitted it.
    const { options } = fakeChrome();
    await notify({ priority: 'important', title: 'Agent', body: 'done', target });
    expect(options[0]?.['contextMessage']).toBe('Click to open this tab');
    expect(options[0]?.['requireInteraction']).toBe(true);
  });

  it('keeps the timer for one nobody can visit', async () => {
    // Nothing would ever take it back otherwise, and it would sit there for the day.
    const { cleared } = fakeChrome();
    vi.useFakeTimers();
    try {
      await notify({ priority: 'important', title: 'Terminal', body: 'done' });
      vi.advanceTimersByTime(30_000);
      expect(cleared).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
