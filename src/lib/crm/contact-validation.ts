/**
 * Contact normalization and validation (pure functions).
 *
 * - Names are Unicode-normalized to NFC so Vietnamese diacritics typed on different systems
 *   (e.g. macOS often produces decomposed NFD text) compare and display consistently.
 * - Email normalization is trim + lowercase only (no Gmail dot/plus folding) — DESIGN §3.2.
 * - Validation is pragmatic: it flags addresses that cannot be sent to through SES without
 *   SMTPUTF8 support (non-ASCII local parts) as invalid rather than silently "fixing" them.
 */

export type EmailStatus = "valid" | "invalid" | "missing";

export type EmailCheck =
  | { status: "valid"; normalized: string }
  | { status: "missing"; normalized: null; reason: "missing" }
  | { status: "invalid"; normalized: string; reason: EmailInvalidReason };

export type EmailInvalidReason =
  | "no_at_sign"
  | "multiple_at_signs"
  | "empty_local_part"
  | "empty_domain"
  | "contains_whitespace"
  | "non_ascii"
  | "consecutive_dots"
  | "leading_or_trailing_dot"
  | "domain_without_dot"
  | "invalid_characters"
  | "too_long";

const LOCAL_ALLOWED = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function normalizeText(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.normalize("NFC").replace(/\s+/g, " ").trim();
  return t.length ? t : null;
}

export function checkEmail(raw: string | null | undefined): EmailCheck {
  const trimmed = (raw ?? "").normalize("NFC").trim();
  if (!trimmed) return { status: "missing", normalized: null, reason: "missing" };
  const normalized = trimmed.toLowerCase();
  const bad = (reason: EmailInvalidReason): EmailCheck => ({ status: "invalid", normalized, reason });

  if (/\s/.test(trimmed)) return bad("contains_whitespace");
  if (/[^\x00-\x7F]/.test(trimmed)) return bad("non_ascii");
  const at = trimmed.split("@");
  if (at.length === 1) return bad("no_at_sign");
  if (at.length > 2) return bad("multiple_at_signs");
  const [local, domain] = at;
  if (!local) return bad("empty_local_part");
  if (!domain) return bad("empty_domain");
  if (trimmed.length > 254 || local.length > 64) return bad("too_long");
  if (local.startsWith(".") || local.endsWith(".") || domain.startsWith(".") || domain.endsWith(".")) return bad("leading_or_trailing_dot");
  if (local.includes("..") || domain.includes("..")) return bad("consecutive_dots");
  if (!LOCAL_ALLOWED.test(local)) return bad("invalid_characters");
  const labels = domain.split(".");
  if (labels.length < 2) return bad("domain_without_dot");
  if (!labels.every((l) => LABEL.test(l))) return bad("invalid_characters");
  if (!/^[A-Za-z]{2,63}$/.test(labels[labels.length - 1])) return bad("invalid_characters");
  return { status: "valid", normalized };
}

export type ContactFields = {
  fullName: string | null;
  greetingName: string | null;
  email: string | null;
  company: string | null;
  tags: string[];
};

export type ContactIssueCode =
  | "email_missing"
  | "email_invalid"
  | "full_name_missing"
  | "greeting_name_missing"
  | "duplicate_email"
  | "email_changed_from_suppressed"
  | "notion_marked_unsubscribed";

export function normalizeContactFields(raw: ContactFields): ContactFields {
  const tags = Array.from(new Set(raw.tags.map((t) => normalizeText(t)).filter((t): t is string => Boolean(t)))).sort((a, b) =>
    a.localeCompare(b, "vi"),
  );
  return {
    fullName: normalizeText(raw.fullName),
    greetingName: normalizeText(raw.greetingName),
    email: raw.email == null ? null : raw.email.normalize("NFC").trim() || null,
    company: normalizeText(raw.company),
    tags,
  };
}

/** Data-quality issues detectable from a single contact (duplicates are computed across contacts). */
export function singleContactIssues(f: ContactFields): { emailCheck: EmailCheck; issues: ContactIssueCode[] } {
  const emailCheck = checkEmail(f.email);
  const issues: ContactIssueCode[] = [];
  if (emailCheck.status === "missing") issues.push("email_missing");
  if (emailCheck.status === "invalid") issues.push("email_invalid");
  if (!f.fullName) issues.push("full_name_missing");
  if (!f.greetingName) issues.push("greeting_name_missing");
  return { emailCheck, issues };
}
