import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The hook script itself, run the way an agent runs it.
 *
 * Everything else about agent state is checked against the endpoint, which is fine for the
 * endpoint and says nothing about the half that actually reports to it. This is a shell script on
 * the agent's critical path, and the only way to know it reads what the agent hands it is to hand
 * it the same thing and see what arrives.
 */
const SCRIPT = fileURLToPath(new URL('../../native-host/agent-hook.sh', import.meta.url));

let server: Server;
let port = 0;
let home = '';
const received: { body: string; token: string }[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tabterm-hook-'));
  mkdirSync(join(home, '.local', 'state', 'tabterm'), { recursive: true });
  writeFileSync(join(home, '.local', 'state', 'tabterm', 'token'), 'a'.repeat(64));

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      const raw = req.headers['x-tabterm-token'];
      received.push({ body, token: Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '') });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function run(hook: string, stdin: string, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'bash',
      [SCRIPT, hook],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: home,
          TABTERM_AGENT_PORT: String(port),
          TABTERM_SESSION: 'tt-1',
          ...env,
        },
      },
      (error) => {
        // The script is best effort by design and exits 0 whatever happens, so a non zero exit
        // here means the script itself is broken and the message is the whole diagnosis.
        if (error === null) resolve();
        else reject(new Error(error.message));
      },
    );
    child.stdin?.end(stdin);
  });
}

/** What the stub was sent, as an object, which is the only thing any of these checks look at. */
const sent = (): Record<string, unknown> =>
  JSON.parse(received[0]?.body ?? '{}') as Record<string, unknown>;

describe('the hook an agent runs', () => {
  it('reports the hook it was named with', async () => {
    received.length = 0;
    await run('Stop', '{}');
    expect(received).toHaveLength(1);
    expect(sent()).toMatchObject({ sessionId: 'tt-1', hook: 'Stop' });
  });

  /**
   * The agent's own session id, read off its standard input.
   *
   * The payload is the only place it exists: not in the environment the session was started with,
   * and not anywhere on the screen. Without reading it, the product can say a pane is running an
   * agent and still not say which conversation it is in, which is what `--resume` needs.
   */
  it('reads the agent session id out of the payload it is given', async () => {
    received.length = 0;
    await run(
      'UserPromptSubmit',
      JSON.stringify({
        session_id: 'c0ffee-1234',
        transcript_path: '/somewhere/x.jsonl',
        cwd: '/tmp',
      }),
    );
    expect(sent()).toMatchObject({ agentSessionId: 'c0ffee-1234' });
  });

  /*
   * And leaves it out rather than inventing one. An older agent, or a hook run by hand, sends
   * nothing useful, and a field made up to fill the shape would end up in a command to paste.
   */
  it('and says nothing about it when the payload has none', async () => {
    received.length = 0;
    await run('Stop', '{"cwd":"/tmp"}');
    expect(sent()).not.toHaveProperty('agentSessionId');
  });

  it('and drops anything that is not a plain identifier', async () => {
    received.length = 0;
    await run('Stop', JSON.stringify({ session_id: 'x"; rm -rf ~' }));
    expect(sent()).not.toHaveProperty('agentSessionId');
  });

  /*
   * A payload that is not JSON at all must not stop the hook reporting: the state is the thing the
   * product depends on, and the id is an extra.
   */
  it('still reports the state when the payload makes no sense', async () => {
    received.length = 0;
    await run('Notification', 'not json at all');
    expect(sent()).toMatchObject({ hook: 'Notification' });
  });

  /**
   * And it does not wait for whoever is writing to it.
   *
   * The agent waits for this script, so reading until end of input means letting somebody else
   * decide when the agent may carry on. A writer that holds the pipe open must cost a moment, not
   * a hook timeout, and the state must still be reported when it does.
   */
  it('reports the state even when nothing closes its input', async () => {
    received.length = 0;
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'bash',
        [SCRIPT, 'Stop'],
        {
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: home,
            TABTERM_AGENT_PORT: String(port),
            TABTERM_SESSION: 'tt-1',
          },
        },
        (error) => {
          if (error === null) resolve();
          else reject(new Error(error.message));
        },
      );
      // Written, and then the pipe is deliberately left open.
      child.stdin?.write('{"session_id":"never-closed"}');
    });
    expect(Date.now() - started, 'the hook waited on the writer').toBeLessThan(4000);
    expect(sent()).toMatchObject({ hook: 'Stop' });
  }, 15000);

  it('says nothing at all for a shell TabTerm did not start', async () => {
    received.length = 0;
    await run('Stop', '{}', { TABTERM_SESSION: '' });
    expect(received).toHaveLength(0);
  });
});
