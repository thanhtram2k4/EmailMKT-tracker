import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { UserRound } from "lucide-react";
import type { CurrentStaff } from "../lib/auth/session";
import { getConfig } from "../lib/config";
import { SidebarNav } from "./sidebar-nav";
import { SignOutButton } from "./sign-out-button";
import { THEME_COOKIE, parseTheme } from "./theme";
import { ThemeToggle } from "./theme-toggle";
import { SendModeBadge } from "./ui";

/**
 * Staff page frame: sidebar navigation, a topbar (send mode, user, theme, sign out) and the
 * page's <main>. Every staff page renders inside it; access is still checked by the page itself.
 */
export async function AppShell({ staff, wide, children }: { staff: CurrentStaff; wide?: boolean; children: ReactNode }) {
  const cfg = getConfig();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <SidebarNav isAdmin={staff.role === "admin"}>
      <header className="app-topbar">
        <div className="topbar-left">
          <SendModeBadge mode={cfg.SEND_MODE} env={cfg.APP_ENV} />
        </div>
        <div className="topbar-right">
          <span className="topbar-user" data-testid="current-user">
            <UserRound className="icon-sm" aria-hidden />
            {staff.email} · <span data-testid="current-role">{staff.role}</span>
          </span>
          <ThemeToggle initial={theme} />
          <SignOutButton />
        </div>
      </header>
      <main id="main" tabIndex={-1} className={`shell${wide ? " wide" : ""}`}>
        {children}
      </main>
    </SidebarNav>
  );
}
