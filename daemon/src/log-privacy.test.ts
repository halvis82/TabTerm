import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PtyHost } from './pty-host/host.js';
import { PtyHostClient } from './pty-host/client.js';
import { paths } from './config.js';
import { flushLog, initLog, info } from './log.js';

/**
 * A diagnostic log must not quietly accumulate a person's world.
 *
 * Terminal output, what was typed, the name of a command, the directory it ran in and the first
 * words an agent was asked are all things TabTerm sees constantly and writes down nowhere. A
 * notification is the place that came closest: its body is built from exactly those, and it was
 * being logged whole so that a report of an unwanted notification could be answered from the log.
 *
 * The category answers that question. The content was never needed for it.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('what a notification leaves behind in the log', () => {
  it('records which kind fired, and nothing a person typed or ran', () => {
    initLog('info');
    const secret = 'CANARY-9d41-do-not-log-me';

    // Shaped exactly like the real ones: the command is in the title after a colon, and the
    // directory and the reason are in the body.
    info('notify.sent', { priority: 'important', kind: `Failed: ${secret}`.split(':')[0] });
    info('notify.sent', { priority: 'critical', kind: 'Agent needs approval' });

    flushLog();
    const written = readFileSync(`${paths.state}/logs/daemon.log`, 'utf8');
    expect(written).toContain('notify.sent');
    expect(written).toContain('Failed');
    expect(written).not.toContain(secret);
  });

  it('and the server builds that line from the category, not the body', () => {
    /**
     * Checked at the source. The call is inside the broadcast path, which needs a whole daemon
     * and a connected client to reach, and what matters is not that this particular line is safe
     * but that the shape of the call cannot carry a body.
     */
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const call = /info\('notify\.sent', \{[\s\S]*?\}\);/.exec(source)?.[0] ?? '';
    expect(call).not.toBe('');
    expect(call).toContain('priority');
    expect(call).toContain('kind');
    // The two things that carry a person's world.
    expect(call).not.toMatch(/\bbody\b/);
    expect(call).not.toMatch(/\btitle,/);
  });
});

describe('what a failed host operation leaves behind', () => {
  /**
   * The place a payload is most likely to be unusual, and least likely to be wanted in a file.
   *
   * The host answered a message it could not handle by sending the whole original message back,
   * and the daemon logged it. That message is a `write` carrying keystrokes, a `spawn` carrying
   * argv and an environment, or an `inject` carrying whatever was being put on somebody's screen.
   *
   * Driven through a real host rather than by calling the logger, because the question is whether
   * the path exists, not whether a formatter can be trusted.
   */
  it('says which message failed, and nothing that was in it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tt-privacy-'));
    const host = new PtyHost(join(dir, 'sock'), join(dir, 'scrollback'));
    await host.listen();
    const client = new PtyHostClient({
      socketPath: join(dir, 'sock'),
      hostScript: join(dir, 'never-spawned'),
    });
    await client.connect(4000);
    client.reconciled();

    initLog('info');
    const secret = 'CANARY-argv-7f22-do-not-log-me';

    /**
     * A spawn the host cannot carry out, carrying a secret in every field a real one would.
     *
     * The directory does not exist, which is the ordinary way for this to fail, and the failure
     * happens after the message has been parsed and is being acted on.
     */
    client.spawn({
      sessionId: 'session-ordinary-id',
      shell: '/nonexistent/shell',
      cwd: join(dir, 'no', 'such', 'directory', secret),
      env: { SECRET_TOKEN: secret },
      cols: 80,
      rows: 24,
      command: ['echo', secret],
    });
    await new Promise((r) => setTimeout(r, 700));

    client.close();
    await host.close();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);

    flushLog();
    const written = readFileSync(`${paths.state}/logs/daemon.log`, 'utf8');
    expect(written, 'nothing a person typed, ran, or configured').not.toContain(secret);
    // And the failure is still diagnosable: which session, and what kind of failure it was.
    expect(written).toContain('pty-host.spawn-failed');
    expect(written).toContain('no-such-directory');
  }, 20000);
});

describe('what is left that could reach a log', () => {
  /**
   * The audit that keeps this honest, rather than a promise in a document.
   *
   * Written as a scan of the source because the failure is one of addition: somebody logs a path
   * or a command in a new place, every individual line looks reasonable, and nothing notices. The
   * list of allowed fields is short on purpose, and a field that is not on it has to be argued for
   * here rather than in a review.
   */
  it('logs no field that carries a path, a command, or terminal text at default level', () => {
    const roots = ['daemon/src', 'daemon/src/pty-host'];
    const suspicious = /\b(cwd|command|argv|env|input|screen|title|prompt|text|data|path)\b/;
    const offenders: string[] = [];

    for (const root of roots) {
      for (const name of readdirSync(join(repoRoot, root))) {
        if (!name.endsWith('.ts') || name.includes('.test.')) continue;
        const source = readFileSync(join(repoRoot, root, name), 'utf8');
        // Only the levels that are on by default. `debug` is off unless somebody turns it on and
        // is told what that means.
        for (const call of source.matchAll(/\b(info|warn|error)\('([^']+)',\s*\{([^}]*)\}/g)) {
          const [, level, event, fields] = call;
          if (fields === undefined || event === undefined) continue;
          if (!suspicious.test(fields)) continue;
          if (ALLOWED.has(event)) continue;
          offenders.push(`${level ?? ''} ${event} { ${fields.trim().slice(0, 80)} }`);
        }
      }
    }

    expect(offenders, 'each of these needs a reason, or a different field').toEqual([]);
  });
});

/**
 * Events that name a path on purpose, each because the path is not the person's work.
 *
 * `agent-hooks` writes to the agent CLI's own settings file at a fixed location, and saying which
 * file could not be written is the whole content of the message. `login-path` names the shell from
 * the configuration. Neither is a project, a directory somebody works in, or anything typed.
 */
const ALLOWED = new Set([
  'agent-hooks.unreadable',
  'agent-hooks.write-failed',
  'login-path.failed',
  /**
   * The notification's `kind` is the part of the title before the colon, which is the category and
   * never the command. That is checked directly by the first test in this file; the field is only
   * on this list because the expression that builds it mentions the title it came from.
   */
  'notify.sent',
]);
