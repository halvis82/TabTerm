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
 * Merge two agents' sessions into one list that shows both, newest first.
 *
 * Straight recency alone is wrong, and full round robin is wrong in the other direction.
 *
 * Recency alone hides the agent that is not in daily use: its conversations are never the newest,
 * so a list cut to a handful of rows never contains one, and the feature is present, correct and
 * unreachable.
 *
 * Round robin was the first answer and overcorrected. Alternating strictly means half the rows
 * belong to whichever agent is used less, however old they are, so a conversation from three
 * weeks ago sat above one from an hour earlier and the list read as arbitrary. Measured on a real
 * machine: of eight rows, four were codex sessions between two and twenty days old while recent
 * claude sessions from the same morning were not shown at all.
 *
 * So: **the newest of each agent first, and then strict recency.** Both agents are reachable from
 * the first rows, which is what round robin was protecting, and everything after that is ordered
 * the way "past sessions" is understood, which is what it was breaking.
 */
export function interleaveByAgent<T extends { agent: AgentKind; modifiedAt: number }>(
  sessions: readonly T[],
): T[] {
  const byRecency = [...sessions].sort((a, b) => b.modifiedAt - a.modifiedAt);

  // One reserved place per agent that has anything, in recency order between them, so the top of
  // the list still opens with the most recent thing that happened.
  const reserved: T[] = [];
  const claimed = new Set<AgentKind>();
  for (const session of byRecency) {
    if (claimed.has(session.agent)) continue;
    claimed.add(session.agent);
    reserved.push(session);
  }

  const rest = byRecency.filter((session) => !reserved.includes(session));
  return [...reserved, ...rest];
}

/**
 * Which agent a pane is running, if any, from the program in the foreground.
 *
 * Read from what is actually running rather than from what the pane was opened with: a shell
 * somebody typed `claude` into is an agent pane just as much as one launched as one, and a pane
 * opened as an agent whose CLI has since exited is not one any more.
 *
 * Its own function because a restore has to be honest about the specific thing on the screen,
 * and "is this an agent" is a question worth being able to answer without a running daemon.
 */
export function agentInForeground(program: string | undefined): AgentKind | undefined {
  if (!program) return undefined;
  const name = program.slice(program.lastIndexOf('/') + 1);
  return (Object.keys(AGENT_EXECUTABLE) as AgentKind[]).find(
    (kind) => AGENT_EXECUTABLE[kind] === name,
  );
}
