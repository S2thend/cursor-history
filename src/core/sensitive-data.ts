/** Shared credential detection, text redaction, and host-path anonymization. */

export interface RedactionCounts {
  privateKey: number;
  jwt: number;
  apiKey: number;
  secretAssignment: number;
}

const REDACTION_PATTERNS: ReadonlyArray<{
  rule: string;
  field: keyof RedactionCounts;
  pattern: RegExp;
  /** Additional strict audit matches; replacement keeps its own text boundaries. */
  detectionPattern?: RegExp;
  replacement: string;
}> = Object.freeze([
  {
    rule: 'private-key',
    field: 'privateKey',
    // Complete PEM block.
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    rule: 'private-key',
    field: 'privateKey',
    // Truncated / unterminated PEM header (common in diffs, logs and escaped
    // JSON strings). Consumes the base64-ish body, including `\n` escape
    // sequences, and an optional trailing END marker.
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\\A-Za-z0-9+/=]{0,20000}(?:-+END [A-Z0-9 ]*PRIVATE KEY-----)?/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    rule: 'jwt',
    field: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    rule: 'api-key',
    field: 'apiKey',
    pattern:
      /\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|npm|xoxb|xoxp|xoxa|xoxr|AKIA|ASIA|AIza)[-_A-Za-z0-9]{12,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    rule: 'bearer-token',
    field: 'apiKey',
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: '$1[REDACTED_API_KEY]',
  },
  {
    rule: 'credential-assignment',
    field: 'secretAssignment',
    // FOO_SECRET=..., API_KEY: "...", PASSWORD=..., *_TOKEN=...
    pattern:
      /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|TOKEN|CREDENTIALS?)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"',;]{6,})\3/gi,
    // Preserve the fixture scanner's released conservative acceptance policy,
    // including short secrets whose punctuation counts toward their length.
    detectionPattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s,"']{6,}/gi,
    replacement: '$1$2$3[REDACTED]$3',
  },
]);

/**
 * Redact credentials from a text block.
 *
 * Returns the scrubbed text plus per-category hit counts so callers can report
 * what was removed instead of silently altering the data.
 */
export function redactSensitiveText(text: string): { text: string; counts: RedactionCounts } {
  const counts: RedactionCounts = {
    privateKey: 0,
    jwt: 0,
    apiKey: 0,
    secretAssignment: 0,
  };
  let output = text;
  for (const { field, pattern, replacement } of REDACTION_PATTERNS) {
    const hasBackreference = /\$\d/.test(replacement);
    output = output.replace(pattern, (...args: unknown[]) => {
      counts[field] += 1;
      if (!hasBackreference) return replacement;
      // Preserve assignment names and authorization schemes through captured groups.
      return replacement.replace(/\$(\d)/g, (_, index: string) =>
        String(args[Number(index)] ?? '')
      );
    });
  }
  return { text: output, counts };
}

/** Replace absolute host home paths with a stable placeholder. */
export function anonymizeHostPaths(text: string): string {
  return (
    text
      .replace(/\/Users\/[A-Za-z0-9._-]+/g, '/Users/<user>')
      .replace(/\/home\/[A-Za-z0-9._-]+/g, '/home/<user>')
      // JSON-escaped Windows paths (doubled backslashes) must be handled before
      // the plain form so the escaped case is not partially rewritten.
      .replace(/[A-Za-z]:\\\\Users\\\\[A-Za-z0-9._-]+/g, 'C:\\\\Users\\\\<user>')
      .replace(/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, 'C:\\Users\\<user>')
  );
}

/** A detection includes the matched text; callers decide whether it may be reported. */
export interface SensitiveTextMatch {
  rule: string;
  text: string;
  index: number;
}

/** Detect credentials without changing input; each call uses fresh regex state. */
export function detectSensitiveText(text: string): SensitiveTextMatch[] {
  const matches: SensitiveTextMatch[] = [];
  const seen = new Set<string>();
  for (const { rule, pattern, detectionPattern } of REDACTION_PATTERNS) {
    for (const expression of detectionPattern ? [pattern, detectionPattern] : [pattern]) {
      for (const match of text.matchAll(new RegExp(expression.source, expression.flags))) {
        const diagnostic =
          rule === 'api-key'
            ? /^sk-/.test(match[0])
              ? 'openai-key'
              : /^gh[pousr]_/.test(match[0])
                ? 'github-token'
                : /^AKIA/.test(match[0])
                  ? 'aws-access-key'
                  : rule
            : rule;
        const key = `${diagnostic}:${match.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({ rule: diagnostic, text: match[0], index: match.index });
      }
    }
  }
  return matches;
}
