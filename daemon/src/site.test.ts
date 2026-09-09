import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../../scripts/build-site.mjs';

/**
 * The published privacy page says what the policy says.
 *
 * The policy is written once, in markdown, because that is what is readable in the repository and
 * what has a public history. The Chrome Web Store needs a URL, and a URL wants a page. Two copies
 * of a legal statement is the kind of thing nobody notices has drifted until it matters, so the
 * page is generated and this fails when it is not what the markdown currently produces.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the published site', () => {
  it('has a privacy page that matches PRIVACY.md', () => {
    const markdown = readFileSync(join(root, 'PRIVACY.md'), 'utf8');
    const published = readFileSync(join(root, 'privacy.html'), 'utf8');
    expect(published, 'run `node scripts/build-site.mjs` after editing PRIVACY.md').toBe(
      renderPage(markdown),
    );
  });

  it('says the things the store asks about', () => {
    // Not a rewording check. These are the questions the Chrome Web Store privacy form asks, and a
    // policy that does not answer them is the most common avoidable rejection.
    const markdown = readFileSync(join(root, 'PRIVACY.md'), 'utf8').toLowerCase();
    for (const subject of ['analytics', 'sold', 'clipboard', 'native messaging', 'retention']) {
      expect(markdown, `the policy has to address ${subject}`).toContain(subject);
    }
  });
});
