import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { ROLE_HOME, useAuth } from "@/lib/auth";
import { RedirectIfAuthenticated, RequireAuth } from "@/components/guards";
import { FullPageSpinner } from "@/components/ui/spinner";
import { LoginPage } from "@/routes/auth/login";
import { OtpLoginPage } from "@/routes/auth/otp-login";
import { SsoCallbackPage } from "@/routes/auth/sso";
import { ActivatePage } from "@/routes/auth/activate";
import { ResetPasswordPage } from "@/routes/auth/reset-password";
import { AppLayout, VendorProfilePage } from "@/routes/app/placeholders";
import { OnboardingStartPage } from "@/routes/onboarding/start";
import { ApprovalQueuePage } from "@/routes/app/approvals";
import { FleetPage } from "@/routes/app/fleet";
import { CraneFormPage } from "@/routes/app/crane-form";
import { VendorDetailPage } from "@/routes/app/vendor-detail";
import { SapSheetPage } from "@/routes/app/sap-sheet";
import { SettingsPage } from "@/routes/app/settings";
import { AdminPage } from "@/routes/app/admin";
import { ReplyQueuePage } from "@/routes/app/replies";
import { RfqIndexPage } from "@/routes/app/rfqs";
import { RfqNewPage } from "@/routes/app/rfq-new";
import { RfqFormPage } from "@/routes/app/rfq-form";
import { RfqDetailPage } from "@/routes/app/rfq-detail";
import { VendorDashboardPage } from "@/routes/app/dashboard";
import { EnquiryIndexPage } from "@/routes/app/enquiries";
import {
  EnquiryFormPage,
  EnquiryLineEditorPage,
} from "@/routes/app/enquiry-form";
import { EnquiryDetailPage } from "@/routes/app/enquiry-detail";
import { LineComparisonPage } from "@/routes/app/line-comparison";
import { BookingCalendarPage } from "@/routes/app/booking-calendar";
import { VendorBookingCalendarPage } from "@/routes/app/vendor-calendar";
import { DiscoveryPage } from "@/routes/app/discovery";
import { CraneDetailPage } from "@/routes/app/crane-detail";
import { CommunicationHistoryPage } from "@/routes/app/communications";
import { EnquiryHistoryPage } from "@/routes/app/enquiry-history";
import { SalesDashboardPage } from "@/routes/app/sales";
import { ManagementDashboardPage } from "@/routes/app/management";
import { ReportsPage } from "@/routes/app/reports";

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

const ssoCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/sso",
  component: SsoCallbackPage,
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

/**
 * Vendors land on their dashboard (brief 7.5); staff land on the queue or the
 * tracking list. ROLE_HOME is the single place that decides, so nothing else
 * has to branch per role. A component rather than a `beforeLoad` redirect,
 * because the signed-in user lives in React context, not in router state.
 */
const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: function IndexRedirect() {
    const { user } = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
      if (user) {
        void navigate({ to: ROLE_HOME[user.role] });
      }
    }, [user, navigate]);

    return null;
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboard",
  component: () => (
    <RequireAuth roles={["vendor_user"]}>
      <VendorDashboardPage />
    </RequireAuth>
  ),
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
    // Brief D1: an SML user adds a crane to a chosen vendor's fleet.
    vendorId: typeof search.vendorId === "string" ? search.vendorId : undefined,
  }),
  component: () => (
    <RequireAuth roles={["vendor_user", "sales_user", "admin_user"]}>
      <CraneFormPage />
    </RequireAuth>
  ),
});

const fleetEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/fleet/$craneId/edit",
  component: () => (
    <RequireAuth roles={["vendor_user", "sales_user", "admin_user"]}>
      <CraneFormPage />
    </RequireAuth>
  ),
});

/**
 * A dedicated quotations screen is not in the brief: a vendor's quotation
 * history lives inside their RFQ detail (M5), and the sales-side comparison
 * screens are out of scope (brief 2). The route stays so old links and
 * expectations land somewhere honest rather than 404.
 */
function QuotationsNote() {
  return (
    <div className="card p-8 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Quotations</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
        There is no separate quotation screen. Vendors find their quotes — every
        version of them — inside each RFQ in <strong>My RFQs</strong>; SML works
        quotations from the same RFQ detail screens.
      </p>
    </div>
  );
}

const quotesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/quotes",
  component: QuotationsNote,
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
  // The admin dashboard links here with ?delivery=FAILED to land on the rows
  // whose dispatch failed.
  //
  // `response` and `q` are the vendor inbox's view state. Keeping them in the
  // URL is what makes Back from an RFQ return to the tab the vendor was on, and
  // lets a filtered view be bookmarked. Internal users never set them, and the
  // tracking screen ignores them.
  validateSearch: (
    search: Record<string, unknown>,
  ): { delivery?: "FAILED"; response?: string; q?: string } => ({
    delivery: search.delivery === "FAILED" ? ("FAILED" as const) : undefined,
    response: typeof search.response === "string" ? search.response : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
  }),
  component: RfqIndexPage,
});

const rfqNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/rfqs/new",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <RfqNewPage />
    </RequireAuth>
  ),
});

/**
 * Shared by both audiences: `RfqDetailPage` branches to the vendor view for a
 * vendor user and to the internal view otherwise. The route therefore admits
 * vendors too — the backend still scopes the vendor read to their own recipient
 * row, so a guessed id is a 404 rather than another vendor's RFQ.
 */
const rfqDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/rfqs/$rfqId",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user", "vendor_user"]}>
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

/**
 * Native enquiry intake and sourcing (P1). Internal only: `enquiry:*` is held by
 * admin and the CR team, and the backend re-checks every call, so the vendor
 * role is kept off the routes altogether.
 */
const enquiriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/enquiries",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <EnquiryIndexPage />
    </RequireAuth>
  ),
});

const enquiryNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/enquiries/new",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <EnquiryFormPage />
    </RequireAuth>
  ),
});

const enquiryDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/enquiries/$enquiryId",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <EnquiryDetailPage />
    </RequireAuth>
  ),
});

const enquiryEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/enquiries/$enquiryId/edit",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <EnquiryFormPage />
    </RequireAuth>
  ),
});

const enquiryLineNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/enquiries/$enquiryId/lines/new",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <EnquiryLineEditorPage />
    </RequireAuth>
  ),
});

const enquiryLineEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/enquiries/lines/$lineId/edit",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <EnquiryLineEditorPage />
    </RequireAuth>
  ),
});

/**
 * Quote comparison and final selection (P3, BPD 6.15/6.16). Internal only: the
 * screen carries the internal rental budget, so vendors are kept off the route
 * and the backend re-checks `enquiry:view` on every call.
 */
const lineComparisonRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/enquiries/lines/$lineId/comparison",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <LineComparisonPage />
    </RequireAuth>
  ),
});

/**
 * Manual vendor discovery (P4, BPD 6.8 / 5.9): a browse across every approved
 * vendor's fleet with no enquiry in view. Internal only — vendors read their own
 * fleet through /api/cranes.
 */
const discoveryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/discovery",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <DiscoveryPage />
    </RequireAuth>
  ),
});

/** Crane detail (P4, BPD 6.11): the calendar, flags and transport assumption. */
const craneDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/cranes/$craneId",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <CraneDetailPage />
    </RequireAuth>
  ),
});

/**
 * Communication history (P4, BPD 6.21), scoped by whichever id the caller opened
 * it from. Internal only.
 */
const communicationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/communications",
  validateSearch: (
    search: Record<string, unknown>,
  ): { enquiryId?: string; lineId?: string; rfqId?: string; quotationId?: string } => ({
    enquiryId: typeof search.enquiryId === "string" ? search.enquiryId : undefined,
    lineId: typeof search.lineId === "string" ? search.lineId : undefined,
    rfqId: typeof search.rfqId === "string" ? search.rfqId : undefined,
    quotationId: typeof search.quotationId === "string" ? search.quotationId : undefined,
  }),
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <CommunicationHistoryPage />
    </RequireAuth>
  ),
});

/** The audit trail viewer for one enquiry (P4, BPD 5.14). Internal only. */
const enquiryHistoryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/enquiries/$enquiryId/history",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <EnquiryHistoryPage />
    </RequireAuth>
  ),
});

/**
 * The booking calendar is an internal planning surface: it shows every crane,
 * SML's and vendors' alike, so it sits behind the internal roles. The backend
 * enforces `rfq:track` on the endpoint itself; this guard is the first door.
 */
const bookingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/bookings",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <BookingCalendarPage />
    </RequireAuth>
  ),
});

/**
 * The vendor's own calendar. Same day states as the internal screen, but the
 * backend scopes it to the caller's vendor from the token — there is no vendor
 * filter on this route to widen. Vendors only, for the same reason.
 */
const vendorBookingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/calendar",
  component: () => (
    <RequireAuth roles={["vendor_user"]}>
      <VendorBookingCalendarPage />
    </RequireAuth>
  ),
});

/**
 * Sales can work the queue — search, chase, send invitations — so the route is
 * open to both internal roles. Approval controls are further restricted by the
 * backend, and the detail screen hides them from sales.
 */
/** P5: the CR team's operational dashboard. */
const salesDashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sales",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user"]}>
      <SalesDashboardPage />
    </RequireAuth>
  ),
});

/** P5: the read-only Management Viewer dashboard. */
const managementDashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/management",
  component: () => (
    <RequireAuth roles={["admin_user", "management_viewer"]}>
      <ManagementDashboardPage />
    </RequireAuth>
  ),
});

/** P5: reports. Sales are narrowed to their own enquiries by the API. */
const reportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/reports",
  component: () => (
    <RequireAuth roles={["admin_user", "sales_user", "management_viewer"]}>
      <ReportsPage />
    </RequireAuth>
  ),
});

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
    throw redirect({ to: "/app/approvals" });  },
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

/** The SAP vendor creation sheet (brief D3), admin only. */
const sapSheetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vendors/$vendorId/sap-sheet",
  component: () => (
    <RequireAuth roles={["admin_user"]}>
      <SapSheetPage />
    </RequireAuth>
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: () => (
    <RequireAuth roles={["admin_user"]}>
      <SettingsPage />
    </RequireAuth>
  ),
});

/** The admin dashboard and staff management (P0 B), admin only. */
const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  component: () => (
    <RequireAuth roles={["admin_user"]}>
      <AdminPage />
    </RequireAuth>
  ),
});

/** P6: email/WhatsApp replies that need an admin to complete the match. */
const adminRepliesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/replies",
  component: () => (
    <RequireAuth roles={["admin_user"]}>
      <ReplyQueuePage />
    </RequireAuth>
  ),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  otpLoginRoute,
  ssoCallbackRoute,
  activateRoute,
  resetPasswordRoute,
  onboardingStartRoute,
  appRoute.addChildren([
    indexRoute,
    dashboardRoute,
    profileRoute,
    fleetRoute,
    fleetNewRoute,
    fleetEditRoute,
    quotesRoute,
    rfqsRoute,
    rfqNewRoute,
    rfqDetailRoute,
    rfqEditRoute,
    enquiriesRoute,
    enquiryNewRoute,
    enquiryDetailRoute,
    enquiryEditRoute,
    enquiryLineNewRoute,
    enquiryLineEditRoute,
    lineComparisonRoute,
    enquiryHistoryRoute,
    discoveryRoute,
    craneDetailRoute,
    communicationsRoute,
    bookingsRoute,
    vendorBookingsRoute,
    approvalsRoute,
    salesDashboardRoute,
    managementDashboardRoute,
    reportsRoute,
    vendorsRoute,
    vendorDetailRoute,
    sapSheetRoute,
    settingsRoute,
    adminRoute,
    adminRepliesRoute,
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