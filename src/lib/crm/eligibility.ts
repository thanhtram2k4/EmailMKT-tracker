/**
 * Whether a contact could be selected for a customer campaign, with every blocking reason.
 * Used by the Contacts screens now and by audience selection / snapshot freezing in M5.
 * Send-time checks (suppression, consent, frequency cap) are repeated immediately before each
 * send in M5; this is not a substitute for them.
 */
export type EligibilityInput = {
  state: "active" | "archived";
  emailStatus: "valid" | "invalid" | "missing";
  isDuplicate: boolean;
  /** For duplicates: whether an admin resolved the group, and if this contact is its primary. */
  duplicateResolution: "none" | "primary" | "secondary";
  suppressed: boolean;
  marketingConsent: "unknown" | "granted" | "refused" | "withdrawn";
  /** Setting crm.require_marketing_consent (default true — pending counsel, docs/COMPLIANCE.md). */
  requireConsent: boolean;
};

export type IneligibleReason =
  | "archived"
  | "email_missing"
  | "email_invalid"
  | "duplicate_unresolved"
  | "duplicate_secondary"
  | "suppressed"
  | "consent_withdrawn"
  | "consent_refused"
  | "consent_unknown";

export const REASON_LABELS: Record<IneligibleReason, string> = {
  archived: "Archived (removed or trashed in Notion)",
  email_missing: "No email address",
  email_invalid: "Invalid email address",
  duplicate_unresolved: "Duplicate email — choose a primary contact",
  duplicate_secondary: "Duplicate email — another contact is primary",
  suppressed: "Suppressed (unsubscribed / bounced / complained)",
  consent_withdrawn: "Consent withdrawn",
  consent_refused: "Consent refused",
  consent_unknown: "No recorded marketing consent",
};

export function eligibility(i: EligibilityInput): { eligible: boolean; reasons: IneligibleReason[] } {
  const reasons: IneligibleReason[] = [];
  if (i.state === "archived") reasons.push("archived");
  if (i.emailStatus === "missing") reasons.push("email_missing");
  if (i.emailStatus === "invalid") reasons.push("email_invalid");
  if (i.isDuplicate) {
    if (i.duplicateResolution === "none") reasons.push("duplicate_unresolved");
    else if (i.duplicateResolution === "secondary") reasons.push("duplicate_secondary");
  }
  if (i.suppressed) reasons.push("suppressed");
  if (i.marketingConsent === "withdrawn") reasons.push("consent_withdrawn");
  else if (i.marketingConsent === "refused") reasons.push("consent_refused");
  else if (i.marketingConsent === "unknown" && i.requireConsent) reasons.push("consent_unknown");
  return { eligible: reasons.length === 0, reasons };
}
