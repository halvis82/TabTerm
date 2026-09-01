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
