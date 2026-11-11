import Link from "next/link";
import { DENIAL_MESSAGES, type AccessDenialReason } from "../../lib/auth/access";

export const dynamic = "force-dynamic";

// Session-creation refusals (access revoked/removed after the account was first created) surface
// with Better Auth's generic codes; the exact reason is in the audit log.
const SESSION_REFUSED = new Set(["failed_to_create_session", "unable_to_create_session"]);

function messageFor(code: string | undefined): string {
  if (code && SESSION_REFUSED.has(code)) {
    return "Sign-in was refused because your account does not currently have access (for example, it was revoked). Ask an administrator if this is unexpected.";
  }
  const m = /^ACCESS_DENIED_([A-Z_]+)$/.exec(code ?? "");
  const reason = m?.[1]?.toLowerCase() as AccessDenialReason | undefined;
  if (reason && reason in DENIAL_MESSAGES) return DENIAL_MESSAGES[reason];
  return "Sign-in could not be completed. Please try again or contact an administrator.";
}

export default async function AccessDenied({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="center">
      <div className="card auth-card" data-testid="access-denied">
        <h1 style={{ marginTop: 0, fontSize: 22 }}>Access denied</h1>
        <p>{messageFor(error)}</p>
        {error && (
          <p className="muted" style={{ fontSize: 13 }}>
            Reference: <code data-testid="denial-code">{error}</code>
          </p>
        )}
        <Link href="/sign-in">Back to sign-in</Link>
      </div>
    </main>
  );
}
