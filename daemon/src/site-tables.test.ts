import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../../scripts/build-site.mjs';

/**
 * That the published privacy page says what the policy says, tables included.
 *
 * The generator collected a table's rows while a line began with `| `, and a separator written
 * `|---|---|` has no space after the bar. So a table kept its header and lost every row, the
 * separator was rendered as a paragraph, and the next data row started a second table whose first
 * row became a heading. Four visible symptoms from one missing character, and the permissions table
 * lost `tabGroups` entirely, which is a permission a reviewer would look for and not find.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const markdown = readFileSync(join(root, 'PRIVACY.md'), 'utf8');
const published = readFileSync(join(root, 'privacy.html'), 'utf8');
const fresh = renderPage(markdown);

describe('the published privacy page', () => {
  it('is what the markdown currently produces', () => {
    expect(published).toBe(fresh);
  });

  it('is produced the same way twice', () => {
    expect(renderPage(markdown)).toBe(fresh);
  });

  it('leaks no table syntax', () => {
    expect(fresh).not.toContain('|---');
    expect(fresh).not.toMatch(/<p>\s*\|/);
  });

  it('carries every permission the manifest asks for', () => {
    const manifest = JSON.parse(
      readFileSync(join(root, 'extension/public/manifest.json'), 'utf8'),
    ) as { permissions: string[] };
    for (const permission of manifest.permissions) {
      expect(fresh, `${permission} must appear in the published policy`).toContain(
        `<code>${permission}</code>`,
      );
    }
  });

  it('carries every row of every table in the policy', () => {
    /*
     * Counted rather than sampled. The failure this exists for was rows vanishing quietly, and a
     * check that looks for a few known ones would have passed while most of them were gone.
     */
    const rows = markdown
      .split('\n')
      .filter((l) => l.startsWith('|') && !/^\|[\s:-]+\|/.test(l)).length;
    const rendered = (fresh.match(/<tr>/g) ?? []).length;
    expect(rendered).toBe(rows);
  });
});
