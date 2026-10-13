import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { RedirectIfAuthenticated, RequireAuth } from "@/components/guards";
import { FullPageSpinner } from "@/components/ui/spinner";
import { LoginPage } from "@/routes/auth/login";
import { OtpLoginPage } from "@/routes/auth/otp-login";
import { ActivatePage } from "@/routes/auth/activate";
import { ResetPasswordPage } from "@/routes/auth/reset-password";
import { AppLayout, VendorProfilePage } from "@/routes/app/placeholders";
import { ComingSoon } from "@/routes/app/placeholders";
import { OnboardingStartPage } from "@/routes/onboarding/start";
import { ApprovalQueuePage } from "@/routes/app/approvals";
import { FleetPage } from "@/routes/app/fleet";
import { CraneFormPage } from "@/routes/app/crane-form";
import { VendorDetailPage } from "@/routes/app/vendor-detail";
import { RfqIndexPage } from "@/routes/app/rfqs";
import { RfqFormPage } from "@/routes/app/rfq-form";
import { RfqDetailPage } from "@/routes/app/rfq-detail";

/**
 * Route map.
 *
 * Access rules live in exactly two places: `beforeLoad` here, which keeps a
 * user off a route that is not theirs, and the backend, which is what actually
 * enforces it. Both are needed — the first is for a sane UI, the second is
 * because a browser can be told to do anything.
 */

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="card p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-500">
          That address does not match anything in the portal.
        </p>
        <a href="/auth/login" className="btn-secondary mt-5">
          Go to sign in
        </a>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
    </>
  ),
  notFoundComponent: NotFound,
});

// --- Signed-out ------------------------------------------------------------

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/login",
  component: () => (
    <RedirectIfAuthenticated>
      <LoginPage />
    </RedirectIfAuthenticated>
  ),
});

const otpLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/otp",
  component: () => (
    <RedirectIfAuthenticated>
      <OtpLoginPage />
    </RedirectIfAuthenticated>
  ),
});

const activateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/activate",
  component: ActivatePage,
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/reset-password",
  component: ResetPasswordPage,
});

/**
 * Invitation-gated registration (brief 7.2).
 *
 * Deliberately outside the signed-in tree: the invitee has no account yet. The
 * token in the URL is the only credential, and the backend revalidates it on
 * every request, so there is nothing here to guard.
 */
const onboardingStartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding/start",
  component: OnboardingStartPage,
});

// --- Signed-in -------------------------------------------------------------

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  component: () => (
    <RequireAuth>
      <AppLayout />
    </RequireAuth>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/app/fleet" });
  },
});

const profileRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/profile",
  component: () => (
    <RequireAuth roles={["vendor_user"]}>
      <VendorProfilePage />
    </RequireAuth>
  ),
});

/** Quotations arrive with M5, RFQs with M4, bookings with M8. */
function placeholder(feature: string, milestone: string) {
  return function Placeholder() {
    return <ComingSoon feature={feature} milestone={milestone} />;
  };
}

const fleetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fleet",
  component: () => (
    <RequireAuth roles={["vendor_user"]}>
      <FleetPage />
    </RequireAuth>
  ),
});

/**
 * Add and edit share a screen. `?duplicate=<craneId>` prefills from an existing
 * crane so the copy still goes through the same review and submit path.
 */
const fleetNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fleet/new",
  validateSearch: (search: Record<string, unknown>) => ({
    duplicate: typeof search.duplicate === "string" ? search.duplicate : undefined,
  }),
  component: () => (
    <RequireAuth roles={["vendor_user"]}>
      <CraneFormPage />
    </RequireAuth>
  ),
});

const fleetEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fleet/$craneId/edit",
  component: () => (
    <RequireAuth roles={["vendor_user"]}>
      <CraneFormPage />
    </RequireAuth>
  ),
});

const quotesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/quotes",
  component: placeholder("Quotations", "M5"),
});

/**
 * Internal RFQ work (brief 7.9).
 *
 * `/rfqs` is shared by both audiences and decides internally: a vendor gets the
 * placeholder for their own inbox (M5), an internal user gets the tracking list.
 * The vendor inbox is a separate entity — their recipient row, scoped by their
 * token — so it does not belong on a route that also serves staff.
 *
 * Admins can view, track, extend and cancel. The backend holds `rfq:create` for
 * them too; the create affordance is pointed at sales because that is who the
 * brief has creating RFQs.
 */
const rfqsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/rfqs",
  component: RfqIndexPage,
});

const rfqNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/rfqs/new",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <RfqFormPage />
    </RequireAuth>
  ),
});

const rfqDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/rfqs/$rfqId",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <RfqDetailPage />
    </RequireAuth>
  ),
});

const rfqEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/rfqs/$rfqId/edit",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <RfqFormPage />
    </RequireAuth>
  ),
});

const bookingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bookings",
  component: placeholder("Bookings", "M8"),
});

/**
 * Sales can work the queue — search, chase, send invitations — so the route is
 * open to both internal roles. Approval controls are further restricted by the
 * backend, and the detail screen hides them from sales.
 */
const approvalsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/approvals",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <ApprovalQueuePage />
    </RequireAuth>
  ),
});

const vendorsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vendors",
  beforeLoad: () => {
    throw redirect({ to: "/app/approvals" });
  },
});

/** The registration behind a queue row, and where decisions are made. */
const vendorDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vendors/$vendorId",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <VendorDetailPage />
    </RequireAuth>
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: placeholder("Settings", "M2"),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  otpLoginRoute,
  activateRoute,
  resetPasswordRoute,
  onboardingStartRoute,
  appRoute.addChildren([
    indexRoute,
    profileRoute,
    fleetRoute,
    fleetNewRoute,
    fleetEditRoute,
    quotesRoute,
    rfqsRoute,
    rfqNewRoute,
    rfqDetailRoute,
    rfqEditRoute,
    bookingsRoute,
    approvalsRoute,
    vendorsRoute,
    vendorDetailRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingComponent: FullPageSpinner,
  defaultErrorComponent: ({ error }) => (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="card max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-500">
          {error instanceof Error ? error.message : "An unexpected error occurred."}
        </p>
        <a href="/auth/login" className="btn-secondary mt-5">
          Back to sign in
        </a>
      </div>
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}