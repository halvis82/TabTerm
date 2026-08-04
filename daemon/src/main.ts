import { PROTOCOL_VERSION, VERSION } from '@tabterm/shared';

/**
 * Daemon entry point.
 *
 * The daemon owns every PTY. No terminal process is ever tied to a Chrome page's lifetime.
 * See docs/01-architecture.md.
 */
function main(): void {
  console.error(`tabtermd ${VERSION} (protocol ${String(PROTOCOL_VERSION)})`);
}

main();
