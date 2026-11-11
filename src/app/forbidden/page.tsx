import Link from "next/link";
import { requireStaff } from "../../lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Forbidden() {
  await requireStaff();
  return (
    <main className="shell">
      <div className="card" data-testid="forbidden">
        <h1 style={{ marginTop: 0, fontSize: 20 }}>Administrators only</h1>
        <p>Your role does not include access to this page.</p>
        <Link href="/">Back to dashboard</Link>
      </div>
    </main>
  );
}
