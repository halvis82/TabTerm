import { describe, expect, it } from 'vitest';
import { shouldNotify, type NotifyRequest } from './notifications.js';

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
