import { afterEach, describe, expect, it } from 'vitest';
import { approveOnThisMac } from './approve.js';

/**
 * A test daemon, in a home of its own, answers the approval itself: nobody is at the Mac running
 * the tests to touch the sensor, and a real dialog must never come up in the middle of a run.
 */
describe('approving a new device', () => {
  const before = { ...process.env };
  afterEach(() => {
    process.env = { ...before };
  });

  it('answers as told in a test daemon', async () => {
    process.env['TABTERM_HOME'] = '/tmp/a-test-home';
    process.env['TABTERM_REMOTE_APPROVE'] = 'allow';
    expect(await approveOnThisMac('Test phone', 'AB23')).toBe(true);
    process.env['TABTERM_REMOTE_APPROVE'] = 'deny';
    expect(await approveOnThisMac('Test phone', 'AB23')).toBe(false);
  });
});
