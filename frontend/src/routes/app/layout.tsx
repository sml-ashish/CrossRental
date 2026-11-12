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
  Settings,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";
import { ROLE_HOME, roleLabel, useAuth } from "@/lib/auth";

/**
 * The application shell.
 *
 * Nav entries are declared per role and filtered by the signed-in user's role.
 * This is presentation only: hiding a link is a courtesy to the person using
 * the portal; the backend still refuses the request if it is made by hand.
 *
 * The links are grouped by the job they belong to rather than listed flat,
 * because a flat list of eleven items is a list nobody reads. Below `lg` the
 * same groups live in a drawer — previously the nav was simply hidden, which
 * left the app with no navigation at all on a phone.
 */
interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  roles: readonly string[];
  exact?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { to: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["vendor_user"] },
      { to: "/app/sales", label: "Dashboard", icon: LayoutDashboard, roles: ["sales_user"] },
      {
        to: "/app/management",
        label: "Dashboard",
        icon: LayoutDashboard,
        roles: ["management_viewer"],
      },
    ],
  },
  {
    label: "Sourcing",
    items: [
      {
        to: "/app/enquiries",
        label: "Enquiries",
        icon: Inbox,
        roles: ["sales_user", "admin_user"],
      },
      {
        to: "/app/discovery",
        label: "Discovery",
        icon: Compass,
        roles: ["sales_user", "admin_user"],
      },
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
    ],
  },
  {
    label: "Operations",
    items: [
      {
        to: "/app/bookings",
        label: "Booking calendar",
        icon: CalendarDays,
        roles: ["sales_user", "admin_user"],
      },
      {
        to: "/app/calendar",
        label: "Booking calendar",
        icon: CalendarDays,
        roles: ["vendor_user"],
      },
      { to: "/app/fleet", label: "My fleet", icon: Truck, roles: ["vendor_user"] },
    ],
  },
  {
    label: "Network",
    items: [
      {
        to: "/app/approvals",
        label: "Vendor onboarding",
        icon: Building2,
        roles: ["admin_user", "sales_user"],
      },
    ],
  },
  {
    label: "Insights",
    items: [
      {
        to: "/app/reports",
        label: "Reports",
        icon: BarChart3,
        roles: ["admin_user", "sales_user", "management_viewer"],
      },
      { to: "/app/admin", label: "Admin", icon: ShieldCheck, roles: ["admin_user"], exact: true },
      {
        to: "/app/admin/replies",
        label: "Reply queue",
        icon: MessageSquare,
        roles: ["admin_user"],
      },
      { to: "/app/settings", label: "Settings", icon: Settings, roles: ["admin_user"] },
    ],
  },
];

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // A drawer that survives a navigation is a drawer covering the thing the
  // person just asked for, so close it whenever the route changes.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!user) return null;

  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.roles.includes(user.role)),
  })).filter((group) => group.items.length > 0);

  function onSignOut() {
    logout();
    void navigate({ to: "/auth/login" });
  }

  const identity = (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium text-slate-900">
        {user.fullName ?? user.email}
      </p>
      <p className="truncate text-xs text-slate-500">
        {roleLabel(user.role)}
        {user.vendorName ? ` · ${user.vendorName}` : ""}
      </p>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex size-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 lg:hidden"
            aria-label="Open navigation"
            aria-expanded={open}
          >
            <Menu className="size-4" aria-hidden />
          </button>

          <Link to={ROLE_HOME[user.role]} className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-brand-300 via-brand-500 to-brand-600 text-[11px] font-bold tracking-wide text-white"
              aria-hidden
            >
              SML
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold tracking-tight text-slate-900">
                crossrentel
              </span>
              <span className="block truncate text-[11px] text-slate-500">
                Crane sourcing &amp; vendor network
              </span>
            </span>
          </Link>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">{identity}</div>
            <button
              type="button"
              onClick={onSignOut}
              className="btn-secondary px-2.5 sm:px-3"
              title="Sign out"
            >
              <LogOut className="size-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1440px] gap-6 px-4 py-6 sm:px-6 print:block print:max-w-none print:p-0">
        <nav
          className="hidden w-56 shrink-0 lg:block print:hidden"
          aria-label="Main navigation"
        >
          <div className="sticky top-20 space-y-5">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="px-3 pb-1.5 text-[10px] font-medium tracking-[0.09em] text-slate-400 uppercase">
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <li key={`${item.to}:${item.label}`}>
                      <Link
                        to={item.to}
                        activeOptions={{ exact: item.exact ?? false }}
                        className="group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                        activeProps={{
                          className:
                            "bg-brand-50 font-medium text-brand-700 hover:bg-brand-50 hover:text-brand-700",
                        }}
                      >
                        <item.icon
                          className="size-4 shrink-0 text-slate-400 group-hover:text-slate-600"
                          aria-hidden
                        />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      {/* Mobile navigation drawer. */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-white shadow-xl"
          >
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-4">
              <span className="flex items-center gap-2">
                <span
                  className="flex size-7 items-center justify-center rounded-md bg-gradient-to-b from-brand-300 via-brand-500 to-brand-600 text-[10px] font-bold text-white"
                  aria-hidden
                >
                  SML
                </span>
                <span className="text-sm font-semibold text-slate-900">Menu</span>
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close navigation"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
              {groups.map((group) => (
                <div key={group.label} className="mb-4 last:mb-0">
                  <p className="px-2 pb-1.5 text-[10px] font-medium tracking-[0.09em] text-slate-400 uppercase">
                    {group.label}
                  </p>
                  <ul className="space-y-0.5">
                    {group.items.map((item) => (
                      <li key={`${item.to}:${item.label}`}>
                        <Link
                          to={item.to}
                          activeOptions={{ exact: item.exact ?? false }}
                          className="group flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-slate-600 hover:bg-slate-100"
                          activeProps={{
                            className: "bg-brand-50 font-medium text-brand-700",
                          }}
                        >
                          <item.icon
                            className="size-4 shrink-0 text-slate-400 group-hover:text-slate-600"
                            aria-hidden
                          />
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="shrink-0 border-t border-slate-200 p-3">
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
