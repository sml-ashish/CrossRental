import { Link } from "@tanstack/react-router";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { SettingsSection } from "@/components/settings/parts";

/**
 * Who can be here.
 *
 * There is no access setting to edit: the route guard, the nav filter and the
 * API all restrict this page to `admin_user`, and staff accounts and roles are
 * managed on the admin console. So the honest section is a statement of the
 * rule plus the way to the screen that does change it — not a disabled form.
 */
export function AccessSection() {
  return (
    <SettingsSection
      id="access"
      title="Access"
      summary="Who can read and change configuration."
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4 rounded-xl border border-ink-800 bg-ink-850 p-4">
        <div className="flex min-w-0 gap-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-slate-500" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900">Admins only</p>
            <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-slate-500">
              This page is limited to admin users. Sales, operations and vendors never see it, and
              the API refuses a settings change from anyone else even if the request is made by
              hand. Staff accounts, roles and deactivation live in the admin console.
            </p>
          </div>
        </div>
        <Link
          to="/app/admin"
          className="btn-secondary shrink-0 px-3 py-1.5 text-[13px]"
        >
          Open the admin console
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </SettingsSection>
  );
}
