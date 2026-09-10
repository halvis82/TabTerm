/**
 * Ask macOS for the folders TabTerm needs, once, at a moment that makes sense.
 *
 * There is no API for "grant everything". TCC asks per protected folder, and it asks the first
 * time something reaches into one, which means the prompts arrive scattered across days: one when
 * a path is completed into Documents, another when a session opens in Downloads, a third weeks
 * later on the Desktop. Each one interrupts something unrelated to itself, and none of them
 * explains why TabTerm is asking.
 *
 * So they are asked for together, once, shortly after the first start. Reading a folder is what
 * triggers the prompt; doing it deliberately here means the person answers three questions in a
 * row while they are thinking about having just installed a terminal, rather than one question in
 * the middle of something else.
 *
 * **Never on the critical path.** A folder that has not been decided about does not fail, it
 * *blocks* until somebody answers, so this runs after the server is listening and one folder at a
 * time. A denial is a fine outcome and is not retried: it is an answer, and asking again is what
 * makes software feel like it is nagging.
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { paths } from './config.js';
import { info, warn } from './log.js';
import { safeError } from './safe-error.js';

/** The folders macOS guards that a terminal is routinely pointed at. */
const GUARDED = ['Desktop', 'Documents', 'Downloads'];

/** Written once, so this is a first-run question rather than a recurring one. */
const MARKER = () => join(paths.state, 'asked-for-folders');

export function alreadyAsked(): boolean {
  try {
    return existsSync(MARKER());
  } catch {
    // Unable to tell, so treat it as asked. Prompting again is worse than not prompting.
    return true;
  }
}

/**
 * Touch each guarded folder once, in order, so the prompts arrive together.
 *
 * Returns which folders answered, for the log. Nothing here decides anything or retries: what a
 * person chooses is theirs, and TabTerm's job is only to ask at a sensible moment.
 */
export async function askForFolders(): Promise<{ allowed: string[]; refused: string[] }> {
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const name of GUARDED) {
    try {
      await readdir(join(homedir(), name));
      allowed.push(name);
    } catch {
      /**
       * Refused, or not there at all, and the two are worth the same here.
       *
       * A denial is an answer. Everything that reads a folder already treats an unreadable one as
       * empty, so nothing downstream needs to know which of the two this was.
       */
      refused.push(name);
    }
  }
  try {
    writeFileSync(MARKER(), new Date().toISOString(), { mode: 0o600 });
  } catch (e: unknown) {
    // Only means the question may be asked once more. Not worth failing a startup over.
    warn('folders.marker-failed', { error: safeError(e) });
  }
  info('folders.asked', { allowed: allowed.join(','), refused: refused.join(',') });
  return { allowed, refused };
}
