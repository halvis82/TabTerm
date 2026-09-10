export * from './layout.js';
export * from './model.js';
export * from './protocol.js';

/**
 * Build identity, surfaced by the daemon in its auth response and by `tabterm doctor`.
 *
 * The same number the extension's manifest carries, because they are one product and a person
 * reporting a problem should not have to say which of two versions they mean. `version.test.ts`
 * fails if they drift or if either goes back to being all zeroes.
 */
export const VERSION = '0.1.0';
export * from './placeholders.js';
export * from './template-syntax.js';
export * from './shell-noise.js';
export * from './char-width.js';
