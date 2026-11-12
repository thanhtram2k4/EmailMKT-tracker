import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, CircleCheck, CircleExclamationPoint, CircleX, FlaskConical, Inbox, Info, Send, TriangleExclamationPoint } from "lucide-react";
import { REASON_LABELS, type IneligibleReason } from "../lib/crm/eligibility";

export type Tone = "ok" | "bad" | "warn" | "info";

const TONE_ICON: Record<Tone, typeof Info> = { ok: CircleCheck, bad: CircleX, warn: TriangleExclamationPoint, info: Info };

/** Status message after a form action. Errors use role=alert so screen readers announce them. */
export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) return null;
  const tone: Tone = error ? "bad" : "ok";
  const Icon = TONE_ICON[tone];
  return (
    <div className={`banner ${tone}`} role={error ? "alert" : "status"} data-testid={error ? "flash-error" : "flash-ok"}>
      <Icon className="icon" aria-hidden />
      <div className="banner-body">{error ?? ok}</div>
    </div>
  );
}

/** Callout with an icon. Pass `testId` only where a test needs it (test ids must stay unique). */
export function Alert({ tone = "info", title, children, testId, small, icon = true }: { tone?: Tone; title?: ReactNode; children?: ReactNode; testId?: string; small?: boolean; icon?: boolean }) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={`banner ${tone}${small ? " small" : ""}`} data-testid={testId} role={tone === "bad" ? "alert" : undefined}>
      {icon && <Icon className="icon" aria-hidden />}
      <div className="banner-body">
        {title && <strong>{title}</strong>} {children}
      </div>
    </div>
  );
}

export function Pill({ tone, children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone ?? ""}`} title={title}>
      {children}
    </span>
  );
}

export function PageHeader({ title, sub, actions, back, titleTestId }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { href: string; label: string }; titleTestId?: string }) {
  return (
    <div className="page-header">
      <div>
        {back && (
          <Link href={back.href} className="back-link">
            <ArrowLeft className="icon-sm" aria-hidden /> {back.label}
          </Link>
        )}
        <h1 className="page-title" data-testid={titleTestId}>
          {title}
        </h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Kpi({ label, value, note, icon, testId }: { label: string; value: ReactNode; note?: ReactNode; icon?: ReactNode; testId?: string }) {
  return (
    <div className="kpi" data-testid={testId}>
      <span className="kpi-label">
        {icon}
        {label}
      </span>
      <span className="kpi-value">{value}</span>
      {note && <span className="kpi-note">{note}</span>}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Inbox className="icon" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

/** Compact send-mode indicator for the topbar. The full explanation is on the dashboard. */
export function SendModeBadge({ mode, env }: { mode: string; env: string }) {
  const tone: Tone = mode === "disabled" ? "warn" : mode === "live" ? "bad" : "info";
  const Icon = mode === "disabled" ? CircleExclamationPoint : mode === "mock" ? FlaskConical : Send;
  return (
    <span className={`pill ${tone}`} title={`SEND_MODE=${mode} · APP_ENV=${env}`}>
      <Icon className="icon-sm" aria-hidden />
      <span>
        Gửi email: <strong>{mode}</strong>
      </span>
      <span className="muted">· {env}</span>
    </span>
  );
}

export const CONSENT_TONE: Record<string, Tone | undefined> = { granted: "ok", withdrawn: "bad", refused: "bad", unknown: "warn" };

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
