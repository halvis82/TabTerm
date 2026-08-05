import type { Database } from './database.js';
import type { LoadedProjectConfig } from './project-config.js';
import { info } from './log.js';

/**
 * Whether a project's config may be acted on.
 *
 * Trust is granted by a person, to specific bytes, and never inferred. Three properties do the
 * work, and each exists because the obvious cheaper design is unsafe:
 *
 *  - Approval is keyed by content hash, not by path. Approving a config once must not approve
 *    whatever that file says after a `git pull` or a branch switch.
 *  - There is no "trust all projects" setting. A blanket approval is indistinguishable from no
 *    approval at all, and it is the setting an attacker is counting on.
 *  - Denial is remembered too, so a repository cannot re-ask on every visit until someone
 *    clicks through it.
 *
 * Nothing here runs a command. Trust only decides whether the workspace is *offered*; the
 * commands still run only when a person opens it. See docs/05-security.md §5.
 */

export type TrustDecision = 'trusted' | 'denied';

export interface TrustState {
  /** Ready to offer without asking. */
  status: 'trusted' | 'denied' | 'unknown' | 'changed';
  /** Set when a previous decision covered different content. */
  previousDecision?: TrustDecision;
}

export class ProjectTrust {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  evaluate(config: LoadedProjectConfig): TrustState {
    const row = this.#db.handle
      .prepare('SELECT content_hash, decision FROM project_trust WHERE path = ?')
      .get(config.path) as { content_hash: string; decision: string } | undefined;

    if (!row) return { status: 'unknown' };

    const previous: TrustDecision = row.decision === 'trusted' ? 'trusted' : 'denied';
    if (row.content_hash !== config.contentHash) {
      // The file changed since the decision. Never carry the old answer forward, in either
      // direction: a previously denied config may now be legitimate, and a previously trusted
      // one is exactly how a supply-chain change would arrive.
      return { status: 'changed', previousDecision: previous };
    }
    return { status: previous };
  }

  /** Record a person's answer for exactly the content they were shown. */
  record(config: LoadedProjectConfig, decision: TrustDecision): void {
    this.#db.handle
      .prepare(
        `INSERT INTO project_trust (path, content_hash, decision, decided_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash,
           decision = excluded.decision, decided_at = excluded.decided_at`,
      )
      .run(config.path, config.contentHash, decision, Date.now());
    info('project-trust.recorded', { path: config.path, decision });
  }

  forget(path: string): void {
    this.#db.handle.prepare('DELETE FROM project_trust WHERE path = ?').run(path);
  }

  list(): { path: string; decision: TrustDecision; decidedAt: number }[] {
    const rows = this.#db.handle
      .prepare('SELECT path, decision, decided_at FROM project_trust ORDER BY decided_at DESC')
      .all() as { path: string; decision: string; decided_at: number }[];
    return rows.map((r) => ({
      path: r.path,
      decision: r.decision === 'trusted' ? 'trusted' : 'denied',
      decidedAt: r.decided_at,
    }));
  }
}

/**
 * What the UI should do with a discovered config.
 *
 * Kept pure and separate from storage so the policy itself is testable without a database,
 * because this is the decision that has to be right every time.
 */
export function trustAction(state: TrustState): 'offer' | 'ask' | 'ignore' {
  switch (state.status) {
    case 'trusted':
      return 'offer';
    case 'denied':
      return 'ignore';
    // A changed file is asked about again, never silently re-approved.
    case 'changed':
    case 'unknown':
      return 'ask';
  }
}
