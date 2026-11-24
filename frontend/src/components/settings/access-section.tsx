import { ShieldCheck } from "lucide-react";
import { SettingsSection } from "@/components/settings/parts";

/**
 * Who can be here.
 *
 * There is no access setting to edit: the route guard, the nav filter and the
 * API all restrict this page to `admin_user`. So the honest section is a
 * statement of the rule — not a disabled form.
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
            <p className="mt-1 max-w-[62ch] text-[15px] leading-relaxed text-slate-500">
              This page is limited to admin users. Sales, operations and vendors never see it, and
              the API refuses a settings change from anyone else even if the request is made by
              hand. Staff accounts and roles are managed by SML administrators.
            </p>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

