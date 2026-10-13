import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { ROLE_HOME, roleLabel, useAuth } from "@/lib/auth";

/**
 * Nav entries are declared per role and filtered by the signed-in user's role.
 *
 * This is presentation only. Hiding a link is a courtesy to the person using
 * the portal; the backend still refuses the request if it is made by hand.
 */
interface NavItem {
  to: string;
  label: string;
  roles: readonly string[];
}

const NAV_ITEMS: NavItem[] = [
  { to: "/app/fleet", label: "My Fleet", roles: ["vendor_user"] },
  { to: "/app/quotes", label: "Quotations", roles: ["vendor_user"] },
  // Admins track every RFQ as well as sales; only creating is pointed at sales.
  { to: "/app/rfqs", label: "RFQs", roles: ["vendor_user", "sales_user", "admin_user"] },
  { to: "/app/bookings", label: "Bookings", roles: ["vendor_user", "sales_user"] },
  { to: "/app/rfqs/new", label: "Create RFQ", roles: ["sales_user"] },
  { to: "/app/quotes", label: "Compare Quotes", roles: ["sales_user", "admin_user"] },
  // Sales reach the queue too: they send invitations and chase registrations,
  // and only the Approve/Reject controls are withheld from them.
  { to: "/app/approvals", label: "Vendor Onboarding", roles: ["admin_user", "sales_user"] },
  { to: "/app/settings", label: "Settings", roles: ["admin_user"] },
];

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  const items = NAV_ITEMS.filter((item) => item.roles.includes(user.role));

  function onSignOut() {
    logout();
    void navigate({ to: "/auth/login" });
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-3">
            <div
              className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-b from-brand-300 via-brand-500 to-brand-600 text-sm font-bold text-white"
              aria-hidden
            >
              SML
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-slate-900">Crane Discovery</p>
              <p className="text-xs text-slate-500">
                {user.vendorName ?? (user.role === "vendor_user" ? "Vendor" : "SML Staff")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-slate-700">{user.fullName ?? user.email}</p>
              <p className="text-xs text-slate-500">{roleLabel(user.role)}</p>
            </div>
            <button type="button" onClick={onSignOut} className="btn-secondary px-3" title="Sign out">
              <LogOut className="size-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
        <nav className="hidden w-56 shrink-0 lg:block" aria-label="Main">
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={`${item.to}:${item.label}`}>
                <Link
                  to={item.to}
                  className="block rounded-lg px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-100"
                  activeProps={{
                    className: "bg-brand-50 font-medium text-brand-700 hover:bg-brand-50",
                  }}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export { ROLE_HOME };