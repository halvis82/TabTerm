import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface TerminalCheckpoint {
  host: string;
  through: number;
  cols: number;
  rows: number;
  screen: string;
}

/** A one-use handoff between daemon versions, not another persistent history store. */
export class TerminalCheckpoints {
  constructor(private readonly directory: string) {}

  #path(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid checkpoint session id');
    return join(this.directory, `${id}.json`);
  }

  save(id: string, checkpoint: TerminalCheckpoint): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.#path(id);
    const text = JSON.stringify(checkpoint);
    // Serialized attributes can occupy more bytes than the corresponding cells. Still bounded.
    if (Buffer.byteLength(text) > 256 * 1024 * 1024)
      throw new Error('Checkpoint exceeds size limit');
    writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  take(id: string, host: string | null, latest: number): TerminalCheckpoint | null {
    const path = this.#path(id);
    try {
      if (!host || statSync(path).size > 256 * 1024 * 1024) return null;
      const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<TerminalCheckpoint>;
      if (
        value.host !== host ||
        typeof value.screen !== 'string' ||
        !Number.isSafeInteger(value.through) ||
        value.through === undefined ||
        value.through < 0 ||
        value.through > latest ||
        !Number.isSafeInteger(value.cols) ||
        value.cols === undefined ||
        value.cols < 2 ||
        value.cols > 4096 ||
        !Number.isSafeInteger(value.rows) ||
        value.rows === undefined ||
        value.rows < 1 ||
        value.rows > 4096
      )
        return null;
      return value as TerminalCheckpoint;
    } catch {
      return null;
    } finally {
      try {
        unlinkSync(path);
      } catch {
        /* Absent or already consumed. */
      }
    }
  }

  /** Remove leftovers for sessions that ended while the daemon was away. */
  clear(): void {
    try {
      for (const name of readdirSync(this.directory)) {
        if (/^[a-zA-Z0-9-]+\.json(?:\.tmp)?$/.test(name)) unlinkSync(join(this.directory, name));
      }
    } catch {
      /* No handoff has been written yet. */
    }
  }
}
