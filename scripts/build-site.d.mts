/**
 * Types for the one script a test imports.
 *
 * `build-site.mjs` is plain JavaScript because it runs by hand and by itself, with no build step
 * between writing it and running it. The staleness test imports its renderer rather than shelling
 * out, so that a failure points at the line that differs instead of at a process exit code.
 */
export function renderMarkdown(source: string): string;
export function renderPage(markdown: string): string;
