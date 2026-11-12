import { AppLayout } from "@/routes/app/layout";
import { VendorProfilePage } from "@/routes/app/vendor-profile";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Placeholder for a milestone that has not been built yet.
 *
 * Kept explicit rather than left as a blank route so that a signed-in user who
 * follows a nav link finds an honest explanation instead of an empty screen.
 */
export function ComingSoon({ feature, milestone }: { feature: string; milestone: string }) {
  return (
    <div className="card">
      <EmptyState
        title={feature}
        description={`This screen is not built yet. It is scheduled for ${milestone}.`}
      />
    </div>
  );
}

export { AppLayout, VendorProfilePage };