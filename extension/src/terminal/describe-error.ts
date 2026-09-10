import type { ServerErrorCode } from '@tabterm/shared';

/**
 * What to say when something did not work.
 *
 * The daemon's message is written for a log: short, precise, and assuming the reader knows the
 * protocol. What a person needs is what failed, and what they can do about it. So the code
 * chooses the sentence and the daemon's message is kept as the detail, because a message nobody
 * predicted is still worth more than a generic one.
 *
 * The rule this exists to enforce: never show a bare code or a number. "exit 1" tells somebody
 * nothing, and a terminal that fails without saying why is one nobody can trust.
 */

const SENTENCES: Record<ServerErrorCode, string> = {
  'auth-required': 'TabTerm is not paired with the background service yet.',
  'auth-failed':
    'TabTerm could not authenticate with the background service. Run the installer again.',
  'version-unsupported':
    'This extension and the background service are different versions. Reload the extension.',
  'session-not-found': 'That terminal is no longer there.',
  'session-expired': 'That terminal has ended.',
  'session-attached-elsewhere': 'That session is open somewhere else and could not be moved.',
  'workspace-invalid-layout': 'That split could not be made.',
  'path-not-found': 'That folder does not exist.',
  'drop-failed': 'That file could not be added. It may be larger than 8 MB.',
  // An offer that has gone stale. The tab is fine, so this must read as a small thing.
  'undo-too-late': 'That one cannot be brought back.',
  'not-trusted': 'That project has not been approved, so nothing from it was run.',
  'rate-limited': 'Too many attempts at once. Wait a moment and try again.',
  /**
   * Says what happened and what was not done, because the second half is the reassuring part.
   *
   * TabTerm declines to open a terminal it cannot keep: one owned by the background service dies
   * when that service is updated, and an update is routine. Nothing was created, so nothing was
   * lost.
   */
  'pty-host-unavailable':
    'The terminal service could not be started, so no terminal was opened. Nothing was lost. ' +
    'Try again, or run the installer.',
  internal: 'Something went wrong in the background service.',
};

export function describeError(code: ServerErrorCode, message: string): string {
  const sentence = SENTENCES[code] ?? 'Something went wrong.';
  const detail = message.trim();
  // The detail is appended rather than replaced: it is the only part that says which folder,
  // which session, or which command, and that is usually the useful half.
  return detail === '' || sentence.toLowerCase().includes(detail.toLowerCase())
    ? sentence
    : `${sentence} ${detail}`;
}
