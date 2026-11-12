import { desc } from "drizzle-orm";
import { requireRole } from "../../lib/auth/session";
import { getDb } from "../../lib/db/client";
import { auditLog } from "../../lib/db/schema";
import { listStaff } from "../../lib/staff";
import { AppShell } from "../app-shell";

export const dynamic = "force-dynamic";

const fmt = (d: Date) => d.toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" }) + " (UTC+07:00)";

export default async function StaffPage() {
  const staff = await requireRole("admin");
  const db = getDb();
  const [people, audit] = await Promise.all([
    listStaff(db),
    db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(50),
  ]);

  return (
    <AppShell staff={staff}>
      <section className="card" data-testid="staff-list">
        <h2>Staff access list</h2>
        <p className="muted small mt0">
          Manage with <code>npm run staff:add -- email role</code> / <code>npm run staff:disable -- email</code>. An admin
          screen for this comes later.
        </p>
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.email}>
                  <td>{p.email}</td>
                  <td>{p.role}</td>
                  <td>{p.disabledAt ? <span className="pill bad">revoked</span> : <span className="pill ok">active</span>}</td>
                  <td className="muted">
                    {fmt(p.addedAt)} by {p.addedBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" data-testid="audit-list">
        <h2>Recent audit events</h2>
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="muted">{fmt(a.at)}</td>
                  <td>{a.actor}</td>
                  <td>
                    <code>{a.action}</code>
                  </td>
                  <td>{a.entityId}</td>
                  <td className="muted">
                    <code>{a.after ? JSON.stringify(a.after) : ""}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
