import { quotePath } from './quote-path.js';

/**
 * The command that reopens an agent conversation somewhere else.
 *
 * Asked for by name: a way to take an agent session with you, to another terminal or another
 * machine's, without hunting for the id.
 *
 * The directory is part of the answer. `--resume` does work from anywhere, so the id on its own
 * would reopen the conversation, but it would reopen it pointed at whatever folder the paste
 * happened to land in, and every relative path in that conversation would then mean something
 * else. Verified rather than assumed: resuming from `/tmp` reopened the transcript of a session
 * that had been running in a project directory, and the agent's working directory was `/tmp`.
 *
 * `&&` rather than `;` so a directory that has since been renamed stops the command instead of
 * starting the agent in the wrong place.
 *
 * The agent is named by what reported the id: Claude's hooks and Codex's both hand over their
 * session id, and Codex's say they are Codex's. See `daemon/src/agent-bridge.ts` and
 * docs/09-agent-integration.md.
 */
export function resumeCommandFor(
  agentSessionId: string,
  cwd: string,
  agent: 'claude' | 'codex' = 'claude',
): string {
  // Codex takes the id as a subcommand's argument rather than an option's.
  const resume =
    agent === 'codex' ? `codex resume ${agentSessionId}` : `claude --resume ${agentSessionId}`;
  return cwd === '' ? resume : `cd ${quotePath(cwd)} && ${resume}`;
}
