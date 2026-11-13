import { useEffect, useState } from "react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Building2,
  CalendarDays,
  Compass,
  FileText,
  Inbox,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Menu,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";
import { ROLE_HOME, roleLabel, useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";

/**
 * The application shell.
 *
 * Navigation is a single top bar — the same one the discovery workspace wears —
 * so moving between screens never moves the way back. It scrolls horizontally
 * rather than wrapping, because a second row of links pushes every page down and
 * a bar that changes height between roles looks broken.
 *
 * Entries are declared per role and filtered by the signed-in user's role. This
 * is presentation only: hiding a link is a courtesy to the person using the
 * portal; the backend still refuses the request if it is made by hand.
 */
interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  roles: readonly string[];
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    to: "/app/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    roles: ["vendor_user"],
  },
  { to: "/app/sales", label: "Dashboard", icon: LayoutDashboard, roles: ["sales_user"] },
  {
    to: "/app/management",
    label: "Dashboard",
    icon: LayoutDashboard,
    roles: ["management_viewer"],
  },
  { to: "/app/admin", label: "Dashboard", icon: LayoutDashboard, roles: ["admin_user"], exact: true },
  { to: "/app/enquiries", label: "Enquiries", icon: Inbox, roles: ["sales_user", "admin_user"] },
  { to: "/app/discovery", label: "Find cranes", icon: Compass, roles: ["sales_user", "admin_user"] },
  {
    to: "/app/rfqs",
    label: "RFQs",
    icon: FileText,
    roles: ["vendor_user", "sales_user", "admin_user"],
  },
  {
    to: "/app/quotes",
    label: "Quotations",
    icon: MessageSquare,
    roles: ["sales_user", "admin_user"],
  },
  {
    to: "/app/bookings",
    label: "Bookings",
    icon: CalendarDays,
    roles: ["sales_user", "admin_user"],
  },
  { to: "/app/calendar", label: "Calendar", icon: CalendarDays, roles: ["vendor_user"] },
  { to: "/app/fleet", label: "My fleet", icon: Truck, roles: ["vendor_user"] },
  {
    to: "/app/approvals",
    label: "Vendors",
    icon: Building2,
    roles: ["admin_user", "sales_user"],
  },
  {
    to: "/app/reports",
    label: "Reports",
    icon: BarChart3,
    roles: ["admin_user", "sales_user", "management_viewer"],
  },
  {
    to: "/app/admin/replies",
    label: "Reply queue",
    icon: MessageSquare,
    roles: ["admin_user"],
  },
  { to: "/app/settings", label: "Settings", icon: ShieldCheck, roles: ["admin_user"] },
];

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // A drawer that survives a navigation is a drawer covering the thing the
  // person just asked for, so close it whenever the route changes.
  useEffect(() => {
    setOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open && !menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setMenuOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, menuOpen]);

  if (!user) return null;

  const items = NAV_ITEMS.filter((item) => item.roles.includes(user.role));

  function onSignOut() {
    logout();
    void navigate({ to: "/auth/login" });
  }

  const initials = (user.fullName ?? user.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  const identity = (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium text-slate-900">{user.fullName ?? user.email}</p>
      <p className="truncate text-xs text-slate-500">
        {roleLabel(user.role)}
        {user.vendorName ? ` · ${user.vendorName}` : ""}
      </p>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-900 print:hidden">
        <div className="flex h-12 items-center gap-4 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-ink-800 text-slate-400 transition-colors hover:bg-ink-850 hover:text-white lg:hidden"
            aria-label="Open navigation"
            aria-expanded={open}
          >
            <Menu className="size-4" aria-hidden />
          </button>

          <Link to={ROLE_HOME[user.role]} className="flex shrink-0 items-center gap-2">
            <span className="flex h-6 items-center gap-0.5" aria-hidden>
              <span className="block h-4 w-[3px] -skew-x-[18deg] rounded-full bg-accent-500" />
              <span className="block h-4 w-[3px] -skew-x-[18deg] rounded-full bg-accent-500/60" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-white">crossrentel</span>
          </Link>

          <nav
            aria-label="Main navigation"
            className="hidden min-w-0 flex-1 items-center gap-0.5 overflow-x-auto lg:flex"
          >
            {items.map((item) => (
              <Link
                key={`${item.to}:${item.label}`}
                to={item.to}
                activeOptions={{ exact: item.exact ?? false }}
                className="shrink-0 rounded-md px-2.5 py-1.5 text-[13px] text-slate-500 transition-colors hover:bg-ink-850 hover:text-white"
                activeProps={{ className: "bg-ink-850 text-white" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="relative ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setMenuOpen((value) => !value)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Account"
              className="flex size-8 items-center justify-center rounded-full bg-ink-700 text-[11px] font-semibold tracking-wide text-white transition-colors hover:bg-ink-800"
            >
              {initials || "U"}
            </button>

            {menuOpen ? (
              <>
                <button
                  type="button"
                  aria-label="Close account menu"
                  className="fixed inset-0 z-[60] cursor-default"
                  onClick={() => setMenuOpen(false)}
                />
                <div
                  role="menu"
                  className="absolute top-10 right-0 z-[70] w-60 rounded-xl border border-ink-800 bg-ink-900 p-2 shadow-2xl"
                >
                  <div className="px-2 py-2">{identity}</div>
                  <div className="my-1 h-px bg-ink-800" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={onSignOut}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-slate-600 transition-colors hover:bg-ink-850 hover:text-white"
                  >
                    <LogOut className="size-4" aria-hidden />
                    Sign out
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div className="px-4 py-6 sm:px-6 print:p-0">
        <main className="min-w-0">
          <Outlet />
        </main>
      </div>

      {/* Navigation drawer, below `lg`. */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-[1px]"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r border-ink-800 bg-ink-900 shadow-xl"
          >
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-ink-800 px-4">
              <span className="text-sm font-semibold text-white">Menu</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-ink-850 hover:text-white"
                aria-label="Close navigation"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={`${item.to}:${item.label}`}>
                    <Link
                      to={item.to}
                      activeOptions={{ exact: item.exact ?? false }}
                      className={cn(
                        "group flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-slate-600",
                        "hover:bg-ink-850 hover:text-white",
                      )}
                      activeProps={{ className: "bg-ink-850 font-medium text-white" }}
                    >
                      <item.icon className="size-4 shrink-0 text-slate-400" aria-hidden />
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div className="shrink-0 border-t border-ink-800 p-3">
              <div className="flex items-center gap-2 px-1 pb-2.5">{identity}</div>
              <button type="button" onClick={onSignOut} className="btn-secondary w-full">
                <LogOut className="size-4" aria-hidden />
                Sign out
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { ROLE_HOME };
