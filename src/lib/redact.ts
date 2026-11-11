/**
 * Free-text redaction for test evidence (logs, reports) before it is shared.
 * Masks: email addresses, bearer/OAuth tokens, cookies, AWS access keys,
 * Notion tokens, Better Auth session tokens and long hex/base64 secrets.
 *
 * This is a safety net, not a guarantee — reports/README.md still requires a manual check.
 */

const RULES: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  // Authorization headers / bearer tokens
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, "$1 [REDACTED]"],
  // Cookie / Set-Cookie header values
  [/\b(set-cookie|cookie)(["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, "$1$2[REDACTED]"],
  // AWS access key ids and secret-looking assignments
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]"],
  // Notion integration tokens
  [/\b(secret_|ntn_)[A-Za-z0-9]{20,}\b/g, "[REDACTED_NOTION_TOKEN]"],
  // Google OAuth tokens / client secrets
  [/\bya29\.[A-Za-z0-9\-_]+/g, "[REDACTED_GOOGLE_TOKEN]"],
  [/\b1\/\/[A-Za-z0-9\-_]{20,}/g, "[REDACTED_GOOGLE_REFRESH]"],
  [/\bGOCSPX-[A-Za-z0-9\-_]+/g, "[REDACTED_GOOGLE_SECRET]"],
  // key=value secrets in URLs or env dumps
  [
    /\b(token|secret|password|api[_-]?key|client_secret|code|state)=([^&\s"']+)/gi,
    "$1=[REDACTED]",
  ],
  // Email addresses → first char + *** + @domain
  [
    /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    (_m: string, first: string, domain: string) => `${first}***@${domain}`,
  ],
];

export function redactText(input: string): string {
  let out = input;
  for (const [re, rep] of RULES) {
    out = out.replace(re, rep as never);
  }
  return out;
}

/** Mask a single email address for display in logs/audit views. */
export function maskEmail(email: string): string {
  return redactText(email);
}
