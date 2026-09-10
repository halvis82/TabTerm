#!/usr/bin/env node
// Render PRIVACY.md into the page GitHub Pages serves.
//
//   node scripts/build-site.mjs
//
// The policy is written once, in markdown, because that is what is readable in the repository and
// what has a public history. The Chrome Web Store needs a URL, and a URL wants a page. Generating
// one from the other is the only arrangement where the two cannot disagree, and `site.test.ts`
// fails if the generated file is not what the markdown currently produces.
//
// The renderer handles exactly the constructs the policy uses. It is not a markdown implementation
// and does not want to become one: a dependency here would be a supply chain for one static page.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markup, applied after escaping so the escapes are not themselves marked up. */
const inline = (text) =>
  escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a href="$1">$1</a>');

export function renderMarkdown(source) {
  const out = [];
  const lines = source.split('\n');
  let i = 0;
  let paragraph = [];

  const flush = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      flush();
      i += 1;
      continue;
    }
    if (line.startsWith('---')) {
      flush();
      out.push('<hr />');
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (line.startsWith('| ')) {
      flush();
      /*
       * Any row of the table, however it is written.
       *
       * This took `| ` with the space, and a separator written `|---|---|` has no space after
       * the bar. So the run ended at the separator: the table kept its header and lost every
       * row, the separator fell through to be rendered as a paragraph, and the next data row
       * began a second table whose first row became a heading. One missing character, and all
       * four of those symptoms.
       */
      const rows = [];
      while ((lines[i] ?? '').startsWith('|')) {
        rows.push(lines[i]);
        i += 1;
      }
      const cells = (row) =>
        row
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim());
      /*
       * The alignment rule is found rather than assumed to be second.
       *
       * It always is second in practice, and leaning on that is how a separator this failed to
       * consume became a paragraph. A row whose every cell is dashes is the rule, wherever it
       * sits, and a table without one has a body starting at the second row like any other.
       */
      const isRule = (row) =>
        cells(row).length > 0 && cells(row).every((c) => /^:?-{3,}:?$/.test(c));
      const ruleAt = rows.findIndex(isRule);
      const header = cells(rows[0]);
      const body = rows.slice(ruleAt === -1 ? 1 : ruleAt + 1).map(cells);
      out.push('<table><thead><tr>');
      for (const cell of header) out.push(`<th>${inline(cell)}</th>`);
      out.push('</tr></thead><tbody>');
      for (const row of body) {
        out.push('<tr>');
        for (const cell of row) out.push(`<td>${inline(cell)}</td>`);
        out.push('</tr>');
      }
      out.push('</tbody></table>');
      continue;
    }
    if (line.startsWith('- ')) {
      flush();
      out.push('<ul>');
      while ((lines[i] ?? '').startsWith('- ') || (lines[i] ?? '').startsWith('  ')) {
        const item = lines[i].startsWith('- ') ? lines[i].slice(2) : lines[i].trim();
        if (lines[i].startsWith('- ')) out.push(`<li>${inline(item)}`);
        else out.push(` ${inline(item)}`);
        i += 1;
      }
      out.push('</ul>');
      continue;
    }
    paragraph.push(line.trim());
    i += 1;
  }
  flush();
  return out.join('\n');
}

const STYLE = `      :root { color-scheme: dark; --bg:#14161c; --fg:#d7dbe6; --dim:#8b91a6;
        --accent:#7aa2f7; --panel:rgba(120,130,160,0.12); }
      body { margin:0; background:var(--bg); color:var(--fg);
        font:15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { max-width:680px; margin:0 auto; padding:56px 24px 96px; }
      h1 { font-size:28px; margin:0 0 24px; letter-spacing:-0.01em; }
      h2 { font-size:14px; text-transform:uppercase; letter-spacing:0.08em; color:var(--dim);
        margin:38px 0 10px; }
      h3 { font-size:16px; margin:26px 0 8px; }
      p { margin:12px 0; }
      hr { border:0; border-top:1px solid rgba(120,130,160,0.22); margin:30px 0; }
      a { color:var(--accent); }
      code { background:var(--panel); padding:1px 5px; border-radius:4px;
        font:13px ui-monospace, SFMono-Regular, Menlo, monospace; }
      table { border-collapse:collapse; width:100%; margin:14px 0; display:block; overflow-x:auto; }
      th, td { text-align:left; padding:7px 10px; border-bottom:1px solid rgba(120,130,160,0.18);
        vertical-align:top; font-size:14px; }
      th { color:var(--dim); font-weight:600; }
      ul { padding-left:20px; }
      li { margin:5px 0; }
      footer { margin-top:44px; padding-top:18px; color:var(--dim); font-size:13px;
        border-top:1px solid rgba(120,130,160,0.22); }`;

export function renderPage(markdown) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TabTerm privacy policy</title>
    <!-- Generated from PRIVACY.md by scripts/build-site.mjs. Edit the markdown, not this file. -->
    <style>
${STYLE}
    </style>
  </head>
  <body>
    <main>
${renderMarkdown(markdown)}
      <footer>
        <a href="./">TabTerm</a> &middot;
        <a href="https://github.com/halvis82/TabTerm">Source on GitHub</a>
      </footer>
    </main>
  </body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const markdown = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8');
  writeFileSync(join(ROOT, 'privacy.html'), renderPage(markdown));
  console.log('  privacy.html written from PRIVACY.md');
}
