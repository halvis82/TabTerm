/**
 * Redaction for diagnostic bundles.
 *
 * A bundle nobody dares share is a bundle nobody sends, so the default is redacted and this is
 * the code that makes that claim true. Kept in the daemon package rather than in the script so
 * it can be tested, because "we redact secrets" is exactly the sort of claim that quietly stops
 * being true.
 *
 * See docs/13-packaging.md and docs/05-security.md §9.
 */

export interface RedactionContext {
  home: string;
  hostname: string;
}

/**
 * Build the ordered replacement list.
 *
 * Order matters and is the easiest thing to get wrong: the home directory appears *inside*
 * paths that other rules also match, so replacing it first would stop those from firing. The
 * broadest patterns run last.
 */
export function redactionRules(context: RedactionContext): [RegExp, string][] {
  const rules: [RegExp, string][] = [
    [/"token"\s*:\s*"[^"]*"/g, '"token":"<redacted>"'],
    [/\b(?:password|passwd|secret|api[-_]?key|token)=\S+/gi, '<secret-redacted>'],
    [/\b(?:ghp|gho|github_pat|sk|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, '<credential-redacted>'],
    [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '<email-redacted>'],
    [/\b[0-9a-f]{32,}\b/gi, '<hex-redacted>'],
  ];
  if (context.hostname) rules.push([new RegExp(escapeRegExp(context.hostname), 'g'), '<host>']);
  if (context.home) rules.push([new RegExp(escapeRegExp(context.home), 'g'), '~']);
  return rules;
}

export function redact(text: string, context: RedactionContext): string {
  let out = text;
  for (const [pattern, replacement] of redactionRules(context)) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
