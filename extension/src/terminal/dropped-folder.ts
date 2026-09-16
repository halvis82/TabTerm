/**
 * A folder dropped on a pane, which a browser describes by name and nothing else.
 *
 * Reported as "drag and drop folders doesn't work… it should just give hte path to the folder".
 * The path is exactly what a browser will not hand over: a dropped file arrives as bytes with no
 * location, and a folder has no bytes either, so it went down the path that reads a file and
 * reported that it could not be read.
 *
 * The name is real, though, and the folders this machine is known to work in are already listed on
 * the start screen. A name matching exactly one of them is an answer. Two matches is not, and
 * picking one would put somebody in the wrong directory, which is worse than saying so.
 */
export function resolveDroppedFolder(
  name: string,
  known: readonly string[],
): { path: string } | { ambiguous: number } {
  const unique = [...new Set(known.filter((path) => path.split('/').pop() === name))];
  if (unique.length === 1 && unique[0] !== undefined) return { path: unique[0] };
  return { ambiguous: unique.length };
}
