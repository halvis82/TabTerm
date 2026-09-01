/**
 * How each agent CLI is asked to pick a conversation back up.
 *
 * They do not agree, and assuming they did was the whole defect. Claude takes `--resume <id>` as
 * a flag. Codex takes `resume <id>` as a **subcommand**, so `codex --resume <id>` is rejected,
 * which is exactly what "resume gives an error, at least for codex" was.
 *
 * Kept as a table rather than as branches at the call site, so adding a third agent is a row.
 */

export type AgentKind = 'claude' | 'codex';

/** The executable each agent is normally reached by, before any configuration. */
export const AGENT_EXECUTABLE: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex',
};

/**
 * The full argv for resuming one conversation.
 *
 * `executable` is passed in rather than assumed, so a configured command still wins: somebody
 * whose `claude` is a wrapper script keeps their wrapper.
 */
export function resumeCommand(agent: AgentKind, executable: string, sessionId: string): string[] {
  return agent === 'codex'
    ? [executable, 'resume', sessionId]
    : [executable, '--resume', sessionId];
}

/**
 * Merge two agents' sessions into one list that shows both.
 *
 * Straight recency would be the obvious answer and is the wrong one. One agent is usually the
 * one in daily use, so its conversations are always the newest, and a list cut to a handful of
 * rows would never contain a single row for the other. The feature would be present, correct,
 * and unreachable.
 *
 * So: round robin, newest first within each agent. Both are visible from the first row or two,
 * and recency still decides the order inside each. An agent with nothing to offer simply does
 * not take turns.
 */
export function interleaveByAgent<T extends { agent: AgentKind; modifiedAt: number }>(
  sessions: readonly T[],
): T[] {
  const queues = new Map<AgentKind, T[]>();
  for (const session of sessions) {
    const queue = queues.get(session.agent) ?? [];
    queue.push(session);
    queues.set(session.agent, queue);
  }
  for (const queue of queues.values()) queue.sort((a, b) => b.modifiedAt - a.modifiedAt);

  // Whichever agent has the single newest session leads, so the top row is still the most
  // recent thing that happened.
  const order = [...queues.keys()].sort(
    (a, b) => (queues.get(b)?.[0]?.modifiedAt ?? 0) - (queues.get(a)?.[0]?.modifiedAt ?? 0),
  );

  const out: T[] = [];
  for (let round = 0; out.length < sessions.length; round++) {
    let took = false;
    for (const agent of order) {
      const next = queues.get(agent)?.[round];
      if (next) {
        out.push(next);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}
