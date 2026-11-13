"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ban, CalendarClock, Database, LayoutDashboard, Mail, Megaphone, Menu, RefreshCw, Send, ShieldCheck, TriangleExclamationPoint, Users, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

type Item = { href: string; label: string; icon: ReactNode; adminOnly?: boolean; exact?: boolean };
type Group = { title: string; items: Item[] };

const I = (C: typeof Mail) => <C className="icon" aria-hidden />;

/** Navigation. Internal test tools (/internal) are deliberately never linked from here. */
const GROUPS: Group[] = [
  { title: "Tổng quan", items: [{ href: "/", label: "Dashboard", icon: I(LayoutDashboard), exact: true }] },
  {
    title: "CRM",
    items: [
      { href: "/contacts", label: "Contacts", icon: I(Users), exact: true },
      { href: "/contacts/issues", label: "Data issues", icon: I(TriangleExclamationPoint) },
      { href: "/sync", label: "Sync", icon: I(RefreshCw) },
      { href: "/suppressions", label: "Suppressions", icon: I(Ban) },
    ],
  },
  {
    title: "Nội dung",
    items: [
      { href: "/templates", label: "Emails", icon: I(Mail) },
      { href: "/campaigns", label: "Campaigns", icon: I(Megaphone) },
      { href: "/campaigns/scheduled", label: "Scheduled", icon: I(CalendarClock) },
    ],
  },
  {
    title: "Quản trị",
    items: [
      { href: "/settings/notion", label: "Notion settings", icon: I(Database), adminOnly: true },
      { href: "/settings/sending", label: "Sending", icon: I(Send), adminOnly: true },
      { href: "/staff", label: "Staff & audit", icon: I(ShieldCheck), adminOnly: true },
    ],
  },
];

const ALL_ITEMS = GROUPS.flatMap((g) => g.items);

/**
 * The current item is the one whose href is the LONGEST match of the path ("/" only exactly), so
 * /campaigns/scheduled marks "Scheduled", not "Campaigns", and /contacts/<id> marks "Contacts".
 */
function isCurrent(path: string, it: Item): boolean {
  const matches = (x: Item) => (x.href === "/" ? path === "/" : path === x.href || path.startsWith(`${x.href}/`));
  if (!matches(it)) return false;
  return !ALL_ITEMS.some((o) => o !== it && matches(o) && o.href.length > it.href.length);
}

export function SidebarNav({ isAdmin, children }: { isAdmin: boolean; children: ReactNode }) {
  const path = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="app" data-drawer={open ? "open" : "closed"}>
      <a href="#main" className="skip-link">
        Bỏ qua tới nội dung
      </a>
      <aside className="sidebar" id="app-sidebar" aria-label="Điều hướng chính">
        <Link href="/" className="sidebar-brand">
          <span className="logo" aria-hidden>
            <Mail className="icon-sm" />
          </span>
          Email MKT Tracker
        </Link>
        <nav aria-label="Các mục" data-testid="sidebar-nav">
          {GROUPS.map((g) => {
            const items = g.items.filter((it) => isAdmin || !it.adminOnly);
            if (!items.length) return null;
            return (
              <div className="nav-group" key={g.title}>
                <p className="nav-group-title">{g.title}</p>
                <ul className="nav-list">
                  {items.map((it) => (
                    <li key={it.href}>
                      <Link href={it.href} className="nav-item" onClick={() => setOpen(false)} aria-current={isCurrent(path, it) ? "page" : undefined}>
                        {it.icon}
                        {it.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">Công cụ nội bộ · không gửi email khi SEND_MODE=disabled</div>
      </aside>
      <button type="button" className="drawer-backdrop" aria-label="Đóng menu" tabIndex={-1} onClick={() => setOpen(false)} />
      <div className="app-main">
        <MenuButton open={open} onToggle={() => setOpen((o) => !o)} />
        {children}
      </div>
    </div>
  );
}

/** Rendered inside the topbar slot on small screens (CSS hides it on desktop). */
function MenuButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="btn ghost icon-btn menu-toggle mobile-menu"
      aria-label={open ? "Đóng menu" : "Mở menu"}
      aria-expanded={open}
      aria-controls="app-sidebar"
      onClick={onToggle}
      data-testid="menu-toggle"
    >
      {open ? <X className="icon" aria-hidden /> : <Menu className="icon" aria-hidden />}
    </button>
  );
}
