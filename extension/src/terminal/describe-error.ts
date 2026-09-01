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
  'not-trusted': 'That project has not been approved, so nothing from it was run.',
  'rate-limited': 'Too many attempts at once. Wait a moment and try again.',
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
