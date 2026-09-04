import { describe, expect, it } from 'vitest';
import { describeError } from './describe-error.js';

describe('what a failure says', () => {
  it('says what happened, not a code', () => {
    const said = describeError('path-not-found', 'no such directory');
    expect(said).toContain('does not exist');
    expect(said).not.toContain('path-not-found');
  });

  it('keeps the detail, since that is the part naming the thing that failed', () => {
    expect(describeError('workspace-invalid-layout', 'cannot detach the only pane')).toContain(
      'cannot detach the only pane',
    );
  });

  it('does not repeat itself when the detail says the same thing', () => {
    const said = describeError('path-not-found', 'That folder does not exist.');
    expect(said.match(/does not exist/g)).toHaveLength(1);
  });

  it('still says something when there is no detail at all', () => {
    expect(describeError('internal', '')).not.toBe('');
  });

  it('tells somebody what to do about a version mismatch', () => {
    expect(describeError('version-unsupported', '')).toMatch(/Reload/);
  });
});

/**
 * A stale undo is not an expiry, and the difference is the whole tab.
 *
 * `session-expired` replaces the page with a recovery notice. An offer in the corner that turned
 * out to be too late must not do that: the terminal in front of you is fine.
 */
it('describes an undo that came too late as a small thing', () => {
  const sentence = describeError('undo-too-late', 'that terminal is open in another tab now');
  expect(sentence).toContain('cannot be brought back');
  expect(sentence).toContain('another tab');
  expect(sentence.toLowerCase()).not.toContain('expired');
});
