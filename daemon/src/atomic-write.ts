import { renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Written whole, or not at all.
 *
 * `writeFileSync` truncates first and then fills, so a crash, a full disk or a killed process in
 * between leaves a file that exists and is wrong. That is tolerable for a file this product owns
 * and can rebuild from defaults. It is not tolerable for the two it does not own: a person's
 * `.zshrc` and an agent's own `settings.json`, where the result of a half write is a shell that no
 * longer starts properly or a tool that no longer runs, and nothing that happened is recoverable
 * from anything TabTerm holds.
 *
 * A temporary file beside the target, then a rename. A rename within a directory is atomic, so a
 * reader sees either the whole previous file or the whole new one and never anything between. Same
 * directory because a rename across filesystems is a copy, which has the problem back again.
 *
 * The mode is applied to the temporary before the rename, so the file is never briefly readable by
 * somebody it should not be.
 */
export function writeFileAtomic(path: string, contents: string, mode: number): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode });
    renameSync(temporary, path);
  } catch (e: unknown) {
    // The previous file is still whole, which is the point. The temporary is litter either way.
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* it may never have been created */
    }
    throw e;
  }
}
