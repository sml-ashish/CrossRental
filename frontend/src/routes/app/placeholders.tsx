import { AppLayout } from "@/routes/app/layout";
import { VendorProfilePage } from "@/routes/app/vendor-profile";

/**
 * Placeholder for a milestone that has not been built yet.
 *
 * Kept explicit rather than left as a blank route so that a signed-in user who
 * follows a nav link finds an honest explanation instead of an empty screen.
 */
export function ComingSoon({ feature, milestone }: { feature: string; milestone: string }) {
  return (
    <div className="card p-8 text-center">
      <h1 className="text-lg font-semibold text-slate-900">{feature}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
        This screen is not built yet. It is scheduled for {milestone}.
      </p>
    </div>
  );
}

export { AppLayout, VendorProfilePage };