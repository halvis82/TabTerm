/**
 * When the rows on screen are looked at for paths.
 *
 * xterm caches what a link provider answered for a line and asks again only when the pointer
 * moves to a different line. A path that is not yet confirmed when it is first hovered is
 * therefore answered "not a link", and that answer stands until the pointer leaves and comes
 * back. The way out is to have the answer ready before anybody hovers, which means scanning the
 * visible rows as output arrives rather than when a link is asked for.
 *
 * Scanning on every frame would be wasteful, so it waits for the output to settle. Waiting only
 * for it to settle is what broke: an agent redrawing its own screen renders continuously and
 * never leaves a quiet gap, so the scan was starved for as long as the agent kept working, and
 * the path it had just printed stayed inert the whole time. Measured on a real transcript, the
 * last scan ran while the screen was still filling and none ran after it.
 */

/** How long the output has to be quiet before the visible rows are worth reading. */
export const QUIET_MS = 180;

/** And how long a scan may be put off while output keeps arriving. */
export const MAX_WAIT_MS = 600;

/**
 * Whether this frame should be scanned now rather than waiting for the output to settle.
 *
 * `lastScanAt` of zero means nothing has been scanned yet, which counts as overdue: the first
 * frame of a session is when its first paths appear.
 */
export function scanIsOverdue(
  now: number,
  lastScanAt: number,
  maxWaitMs: number = MAX_WAIT_MS,
): boolean {
  if (lastScanAt === 0) return true;
  return now - lastScanAt >= maxWaitMs;
}

/** How long a "no such path" answer is trusted before the daemon is asked again. */
export const MISS_TTL_MS = 3000;

/**
 * Whether a path that did not exist should be asked about again.
 *
 * A path is printed before it exists more often than you would think: an agent names the file it
 * is about to write, and the shell prompt itself carries the path in the command that creates it.
 * The answer for those is "no such path", and keeping it meant the file never became clickable
 * however long it sat on screen afterwards. A hit is kept forever, because a path that exists is
 * the answer we wanted and re-checking it costs a round trip for nothing.
 */
export function missHasExpired(now: number, seenAt: number, ttlMs: number = MISS_TTL_MS): boolean {
  return now - seenAt >= ttlMs;
}

/** How long a question put to the daemon is assumed to still be on its way. */
export const ASK_TIMEOUT_MS = 5000;

/**
 * Whether a candidate already asked about may be asked about again.
 *
 * Remembering what has been asked stops a screenful of paths turning into a request per frame. It
 * also assumed every question gets an answer, and some do not: the socket may not be open yet when
 * the first screen is drawn, the pane may not have been bound to its session, and the daemon caps
 * how many candidates one message may carry. Any of those left the candidate marked as asked for
 * the life of the page, and a path on the screen that was showing at the time never became
 * clickable, which is exactly what a restored tab shows first.
 */
export function askHasLapsed(
  now: number,
  askedAt: number,
  timeoutMs: number = ASK_TIMEOUT_MS,
): boolean {
  return now - askedAt >= timeoutMs;
}
