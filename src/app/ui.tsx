import type { ReactNode } from "react";
import { REASON_LABELS, type IneligibleReason } from "../lib/crm/eligibility";

export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  return (
    <div className={`banner ${error ? "bad" : ""}`} role={error ? "alert" : "status"} data-testid={error ? "flash-error" : "flash-ok"}>
      {error ?? ok}
    </div>
  );
}

export function Pill({ tone, children, title }: { tone?: "ok" | "bad" | "warn"; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone ?? ""}`} title={title}>
      {children}
    </span>
  );
}

export const CONSENT_TONE: Record<string, "ok" | "bad" | "warn" | undefined> = { granted: "ok", withdrawn: "bad", refused: "bad", unknown: "warn" };

export function ReasonList({ reasons }: { reasons: IneligibleReason[] }) {
  if (!reasons.length) return <Pill tone="ok">eligible</Pill>;
  return (
    <span className="reasons">
      {reasons.map((r) => (
        <Pill key={r} tone={r === "consent_unknown" ? "warn" : "bad"} title={REASON_LABELS[r]}>
          {r.replace(/_/g, " ")}
        </Pill>
      ))}
    </span>
  );
}

export const fmtTime = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "medium", timeStyle: "short" }) : "—";
