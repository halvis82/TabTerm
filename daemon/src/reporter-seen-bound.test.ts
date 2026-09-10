import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from './config.js';
import { LocalPtyBackend } from './pty-backend.js';
import { initLog } from './log.js';
import { SessionManager } from './session-manager.js';

/**
 * The record of what each browser profile has held, and why it cannot grow for ever.
 *
 * It is deliberately kept when a reporter goes away, because it says what that browser has held
 * rather than what it holds now, and that provenance is what lets a window closed while the worker
 * was asleep still be recognised later. Nothing ever removed an entry from it, so a profile that
 * opens and closes workspaces accumulates one line for every workspace it has ever seen, for as
 * long as the daemon runs.
 *
 * Bounded rather than swept, because there is no moment at which a workspace becomes provably gone
 * for ever, and oldest first because a reconnecting browser asks about the recent ones.
 */
const config: Config = { ...DEFAULTS };
let manager: SessionManager;

beforeAll(() => {
  initLog('error');
  manager = new SessionManager(
    config,
    { onExit: () => {}, onStateChange: () => {} },
    new LocalPtyBackend(),
  );
});

describe('what a browser profile is remembered as having held', () => {
  it('is bounded well above any real number of workspaces', () => {
    expect(SessionManager.SEEN_PER_PROFILE).toBeGreaterThanOrEqual(200);
  });

  it('keeps the most recent when the bound is reached, and drops the oldest', () => {
    const profile = 'profile-a';
    const total = SessionManager.SEEN_PER_PROFILE + 50;
    for (let i = 0; i < total; i++)
      manager.noteWorkspaceOwner(`${profile}:control`, `ws-${String(i)}`);

    // The newest is still attributed to this profile.
    expect(manager.ownersOf(`ws-${String(total - 1)}`)).toContain(profile);
    // The oldest has been let go, which is what stops the record growing without end.
    expect(manager.ownersOf('ws-0')).not.toContain(profile);
    // And the one just inside the bound is still there.
    expect(manager.ownersOf(`ws-${String(total - SessionManager.SEEN_PER_PROFILE)}`)).toContain(
      profile,
    );
  });
});
