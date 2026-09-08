import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
