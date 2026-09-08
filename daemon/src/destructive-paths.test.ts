import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The list of ways this product can signal somebody's process, kept short on purpose.
 *
 * Not a style rule. The invariant is that no code can end a terminal without naming what
 * authorizes it, and that is only true while the number of places able to do so stays small
 * enough to read. A new one added in good faith, for reconciliation or cleanup or shutdown, is
 * exactly how the guarantee was lost the last time.
 *
 * If this test fails, either the new call site belongs on the list with a reason, or it should be
 * going through `SessionManager.terminate` with a cause.
 */
const HERE = new URL('.', import.meta.url).pathname;

/** Files allowed to reach a PTY directly, and why each one is. */
const MAY_SIGNAL: Record<string, string> = {
  'pty-manager.ts': 'the implementation of signalling itself',
  'pty-backend.ts': 'the daemon-owned backend, development only, reached through terminate',
  'pty-host/host.ts': 'the host acting on a kill frame the daemon sent through terminate',
};

/** Files allowed to call the one method that ends a session, and why. */
const MAY_TERMINATE: Record<string, string> = {
  'session-manager.ts': 'the reap timer, which carries the close evidence it re-read',
  'server.ts': 'the four things a person can press: kill, close a pane, replace a pane, reset',
};

function sourceFiles(dir: string, prefix = ''): [name: string, text: string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full, `${prefix}${entry.name}/`));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    out.push([`${prefix}${entry.name}`, readFileSync(full, 'utf8')]);
  }
  return out;
}

const FILES = sourceFiles(HERE);

describe('the ways TabTerm can signal a process', () => {
  it('reads the daemon source at all, so an empty list cannot pass', () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it('has exactly the files that may reach a PTY directly, and no others', () => {
    const reaching = FILES.filter(([, text]) => /\bkillPty\s*\(/.test(text)).map(([name]) => name);
    expect(reaching.sort()).toEqual(Object.keys(MAY_SIGNAL).sort());
  });

  it('has exactly the files that may end a session, and no others', () => {
    const ending = FILES.filter(([, text]) =>
      /\.terminate\(\s*session|\.terminate\(\s*old|this\.terminate\(/.test(text),
    ).map(([name]) => name);
    expect(ending.sort()).toEqual(Object.keys(MAY_TERMINATE).sort());
  });

  it('names a cause at every one of them, since the type requires it', () => {
    /**
     * Checked in the text as well as by the compiler, because the compiler is satisfied by a
     * cause and this is about the causes being the six that mean something. A seventh added as
     * `{ kind: 'cleanup' }` would compile only after somebody widened the union, and widening the
     * union is the change that should be hard to make quietly.
     */
    const manager = FILES.find(([name]) => name === 'session-manager.ts')?.[1] ?? '';
    const causes = [...manager.matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1]);
    expect(new Set(causes)).toEqual(
      new Set([
        'user-kill',
        'user-closed-pane',
        'user-replaced-pane',
        'user-reset',
        'expired-after-tab-close',
        /**
         * A live browser, with its tabs enumerated, no longer has this workspace.
         *
         * Added deliberately, and this list is why it had to be. The timer used to end with an
         * unconditional `expired-after-pane-close`, so a workspace timeout that could not name
         * its own authorization borrowed the provenance of a pane close that never happened. A
         * cause is the evidence; a fallback cause is a lie in the record that says why a
         * terminal was ended.
         */
        'expired-after-window-close',
        'expired-after-pane-close',
      ]),
    );
  });

  it('lets go of a lost session without signalling, and says so in one place only', () => {
    const users = FILES.filter(([, text]) => /forgetLostSession\(/.test(text)).map(([n]) => n);
    // Defined in the manager, used by the host reconnect. Nowhere else needs it.
    expect(users.sort()).toEqual(['main.ts', 'session-manager.ts']);
    const manager = FILES.find(([name]) => name === 'session-manager.ts')?.[1] ?? '';
    const body = manager.slice(manager.indexOf('forgetLostSession('));
    const upToNextMethod = body.slice(0, body.indexOf('\n  }'));
    expect(upToNextMethod, 'letting go must not signal anything').not.toMatch(/kill|terminate/);
  });
});
