import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { paths } from './config.js';
import { info, warn } from './log.js';

/**
 * The token is the only security boundary on the local socket.
 *
 * Origin headers are forgeable by any local process, and any website can open a WebSocket to
 * loopback with no CORS preflight. See docs/05-security.md §2.
 */
const TOKEN_BYTES = 32; // 256 bits

let token: Buffer | null = null;

export function initAuth(): string {
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });

  let hex: string;
  try {
    const mode = statSync(paths.tokenFile).mode & 0o777;
    if (mode !== 0o600) {
      // Refuse to start rather than silently widening or narrowing someone's file.
      throw new Error(
        `token file ${paths.tokenFile} has mode ${mode.toString(8)}, expected 600. ` +
          `Fix it or delete it to have a new token generated.`,
      );
    }
    hex = readFileSync(paths.tokenFile, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('token file is malformed');
    info('auth.token.loaded');
  } catch (e) {
    if (e instanceof Error && e.message.includes('expected 600')) throw e;
    hex = randomBytes(TOKEN_BYTES).toString('hex');
    writeFileSync(paths.tokenFile, hex, { mode: 0o600 });
    chmodSync(paths.tokenFile, 0o600);
    info('auth.token.generated');
  }

  token = Buffer.from(hex, 'hex');
  return hex;
}

export function verifyToken(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !token) return false;
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
  const buf = Buffer.from(candidate, 'hex');
  if (buf.length !== token.length) return false;
  return timingSafeEqual(buf, token);
}

/**
 * Failure backoff.
 *
 * Everything reaching this daemon comes from 127.0.0.1, so the source address cannot
 * discriminate between the real extension and a hostile local process. Refusing connections
 * after failures would therefore lock out the legitimate client, which is a self-inflicted
 * denial of service and strictly worse than the attack it prevents.
 *
 * So this DELAYS rather than refuses. A correct token always gets through, just later. The
 * real protection is that the token is 256 bits and cannot be guessed; this only stops a
 * local process from grinding cheaply.
 */
const failures = new Map<string, { count: number; last: number }>();
const MAX_DELAY_MS = 2000;

export function authDelayMs(source: string): number {
  const entry = failures.get(source);
  if (!entry) return 0;
  if (Date.now() - entry.last > 60_000) {
    failures.delete(source);
    return 0;
  }
  return Math.min(MAX_DELAY_MS, entry.count * 100);
}

export function recordFailure(source: string): void {
  const entry = failures.get(source) ?? { count: 0, last: 0 };
  entry.count++;
  entry.last = Date.now();
  failures.set(source, entry);
  warn('auth.failed', { source, attempt: entry.count });
}

export function recordSuccess(source: string): void {
  failures.delete(source);
}
