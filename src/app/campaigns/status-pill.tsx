import { Pill, type Tone } from "../ui";

const TONES: Record<string, Tone | undefined> = {
  draft: undefined,
  scheduled: "info",
  held_overdue: "bad",
  queued: "info",
  sending: "info",
  paused: "warn",
  blocked: "bad",
  cancelling: "warn",
  cancelled: undefined,
  completed: "ok",
  completed_with_issues: "warn",
  failed: "bad",
};

const LABELS: Record<string, string> = { completed_with_issues: "completed with issues", held_overdue: "held (overdue)" };

/** Status is always shown as text, never by colour alone. */
export function StatusPill({ status, testId }: { status: string; testId?: string }) {
  return (
    <span data-testid={testId}>
      <Pill tone={TONES[status]}>{LABELS[status] ?? status}</Pill>
    </span>
  );
}
