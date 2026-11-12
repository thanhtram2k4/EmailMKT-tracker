import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { requireStaff } from "../../lib/auth/session";
import { AppShell } from "../app-shell";

export const dynamic = "force-dynamic";

export default async function Forbidden() {
  const staff = await requireStaff();
  return (
    <AppShell staff={staff}>
      <div className="card auth-card" data-testid="forbidden">
        <h1 className="page-title">
          <ShieldCheck className="icon" aria-hidden /> Administrators only
        </h1>
        <p>Your role does not include access to this page.</p>
        <Link href="/">Back to dashboard</Link>
      </div>
    </AppShell>
  );
}
