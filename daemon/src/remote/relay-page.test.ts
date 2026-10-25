import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderRelayPage } from '../../../scripts/build-relay.mjs';

/**
 * The page in the relay folder is the page the source builds.
 *
 * It is committed, so deploying a relay needs nothing else, and a committed build is exactly the
 * thing that goes stale without anybody noticing.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('the relay page', () => {
  it('matches its source', async () => {
    const committed = readFileSync(join(root, 'relay', 'page.html'), 'utf8');
    expect(committed === (await renderRelayPage()), 'run `npm run build:relay`').toBe(true);
  });

  it('loads nothing from anywhere else', () => {
    const page = readFileSync(join(root, 'relay', 'page.html'), 'utf8');
    expect(page).not.toMatch(/<script[^>]+src=/);
    expect(page).not.toMatch(/<link[^>]+stylesheet/);
  });
});
