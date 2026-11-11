import Link from "next/link";
import type { CurrentStaff } from "../lib/auth/session";
import { SignOutButton } from "./sign-out-button";

export function AppHeader({ staff }: { staff: CurrentStaff }) {
  return (
    <header className="topbar">
      <div className="brand">Email MKT Tracker</div>
      <nav className="nav">
        <Link href="/">Dashboard</Link>
        {staff.role === "admin" && <Link href="/staff">Staff &amp; audit</Link>}
        <span className="muted" data-testid="current-user">
          {staff.email} · <span data-testid="current-role">{staff.role}</span>
        </span>
        <SignOutButton />
      </nav>
    </header>
  );
}
