import { describe, expect, it, vi } from 'vitest';
import { notify, shouldNotify, type NotifyRequest } from './notifications.js';

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
