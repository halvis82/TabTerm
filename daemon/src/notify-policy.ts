import type { NotifyPolicy } from '@tabterm/shared';

/**
 * When something that finished is worth interrupting a person for.
 *
 * Kept pure and separate from the code that sends notifications, because this is the part with
 * an opinion in it and the part most likely to be argued with later.
 * See docs/06-chrome-integration.md.
 */

export type { NotifyPolicy };

/**
 * Sixty seconds.
 *
 * Long enough that anything reaching it is something you tabbed away from, which is the whole
 * premise. The floor and ceiling exist so a stored value cannot make this useless in either
 * direction: five seconds notifies about `ls`, and an hour notifies about nothing.
 */
export const DEFAULT_NOTIFY_POLICY: NotifyPolicy = {
  enabled: true,
  thresholdMs: 60_000,
  commands: true,
  agentTurns: true,
  onlyWhenUnfocused: true,
};

export const MIN_THRESHOLD_MS = 5_000;
export const MAX_THRESHOLD_MS = 600_000;

export function clampPolicy(input: Partial<NotifyPolicy> | undefined): NotifyPolicy {
  const raw = input?.thresholdMs;
  const thresholdMs =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(MAX_THRESHOLD_MS, Math.max(MIN_THRESHOLD_MS, Math.round(raw)))
      : DEFAULT_NOTIFY_POLICY.thresholdMs;
  return { ...DEFAULT_NOTIFY_POLICY, ...input, thresholdMs };
}

export type Finished =
  | { kind: 'command'; command: string; durationMs: number; exitCode?: number }
  | { kind: 'agent-turn'; durationMs: number; failed?: boolean };

export interface NotifyDecision {
  priority: 'critical' | 'important';
  title: string;
  body: string;
}

/** How long a thing took, in the shortest form that is still honest about its magnitude. */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${String(Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds)}s`;
}

/**
 * Whether a finished thing becomes a notification, and what it says.
 *
 * A failure is worth saying whatever it is, but only once it has passed the same threshold: a
 * command that fails instantly is a typo, and being told about typos is how people turn
 * notifications off.
 */
export function decide(
  event: Finished,
  policy: NotifyPolicy,
  where?: string,
): NotifyDecision | null {
  if (!policy.enabled) return null;
  if (event.durationMs < policy.thresholdMs) return null;

  const took = humanDuration(event.durationMs);
  const place = where ? ` in ${where}` : '';

  if (event.kind === 'agent-turn') {
    if (!policy.agentTurns) return null;
    return event.failed === true
      ? {
          priority: 'critical',
          title: 'Agent stopped with an error',
          body: `After ${took}${place}`,
        }
      : { priority: 'important', title: 'Agent finished', body: `Took ${took}${place}` };
  }

  if (!policy.commands) return null;
  // Unknown is not success. Without shell integration there is no exit code, so it says the
  // command finished and how long it took, which is true, rather than that it worked.
  const failed = event.exitCode !== undefined && event.exitCode !== 0;
  return {
    priority: failed ? 'critical' : 'important',
    // The command leads, because the first thing anyone wants to know is which one this was.
    title: failed ? `Failed: ${event.command}` : `Finished: ${event.command}`,
    body: failed ? `Exit ${String(event.exitCode)} after ${took}${place}` : `Took ${took}${place}`,
  };
}
