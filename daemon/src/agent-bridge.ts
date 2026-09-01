import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentState } from '@tabterm/shared';
import { info, warn } from './log.js';

/**
 * Structured agent state, from hooks rather than from the screen.
 *
 * An agent CLI's terminal interface changes with every version, every theme, and every window
 * width, and a regex over it fails silently and confidently. Hooks are a supported channel
 * that says exactly what happened. Nothing here ever falls back to reading output.
 * See ADR-0009 and docs/09-agent-integration.md.
 *
 * The endpoint authenticates with the same token as the socket, and correlates events to a
 * session by the identifier the daemon put in that session's environment.
 */

export interface AgentEvent {
  sessionId: string;
  state: AgentState;
  detail?: string;
}

export interface AgentBridgeOptions {
  port: number;
  verifyToken: (token: string) => boolean;
  onEvent: (event: AgentEvent) => void;
}

/** What a hook name means. Anything unrecognized is ignored rather than guessed at. */
export function mapHookToState(hook: string): AgentState | null {
  switch (hook) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
      return 'working';
    case 'Notification':
      return 'waiting';
    case 'PermissionRequest':
      return 'approval';
    case 'Stop':
    case 'SubagentStop':
      return 'idle';
    case 'SessionStart':
      return 'starting';
    case 'Error':
      return 'failed';
    default:
      // A hook this version does not know about must not become a wrong state. Silence is
      // better than a confidently incorrect indicator.
      return null;
  }
}

export class AgentBridge {
  readonly #http: Server;
  readonly #opts: AgentBridgeOptions;

  constructor(opts: AgentBridgeOptions) {
    this.#opts = opts;
    this.#http = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      // Loopback only, like everything else the daemon exposes. See docs/05-security.md.
      this.#http.listen(this.#opts.port, '127.0.0.1', () => {
        info('agent-bridge.listening', { port: this.#opts.port });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.#http.close(() => r()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !req.url?.startsWith('/agent-event')) {
      res.writeHead(404);
      res.end();
      return;
    }

    // A repeated header arrives as an array. Taking the first is the only safe reading: a
    // request that supplies the token twice is not one to reason about generously.
    const rawToken = req.headers['x-tabterm-token'];
    const token = Array.isArray(rawToken) ? (rawToken[0] ?? '') : (rawToken ?? '');
    if (!this.#opts.verifyToken(token)) {
      // Same boundary as the socket: a valid token is the only thing that grants anything.
      res.writeHead(401);
      res.end();
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > 64 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
    }

    try {
      const parsed = JSON.parse(body) as { sessionId?: unknown; hook?: unknown; detail?: unknown };
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
      const hook = typeof parsed.hook === 'string' ? parsed.hook : '';
      const state = mapHookToState(hook);

      if (!sessionId || state === null) {
        // Accepted but ignored: a hook we do not recognize is not an error worth surfacing to
        // whatever process is calling us.
        res.writeHead(204);
        res.end();
        return;
      }

      this.#opts.onEvent({
        sessionId,
        state,
        ...(typeof parsed.detail === 'string' ? { detail: parsed.detail.slice(0, 500) } : {}),
      });
      res.writeHead(204);
      res.end();
    } catch {
      warn('agent-bridge.bad-payload');
      res.writeHead(400);
      res.end();
    }
  }
}
