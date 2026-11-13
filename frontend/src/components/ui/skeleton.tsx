import { cn } from "@/lib/cn";

/**
 * A loading placeholder.
 *
 * Screens used to answer "the data is on its way" with a spinner on one line,
 * which collapses the page and then pushes it back out when the content lands.
 * A skeleton holds the shape of the thing that is coming, so the list does not
 * jump. It is always purely decorative: `aria-hidden`, with a `role="status"`
 * label supplied once by the screen if a live announcement is needed.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-ink-800", className)} />;
}

/** A dense row-shaped skeleton, matching the ~90 px list rows. */
export function SkeletonRow() {
  return (
    <div className="rounded-[14px] border border-ink-800 bg-ink-900 px-4 py-3.5">
      <div className="flex items-start gap-4">
        <Skeleton className="h-12 w-16 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-2.5 w-28" />
          <Skeleton className="h-3.5 w-52" />
          <Skeleton className="h-2.5 w-40" />
        </div>
        <Skeleton className="hidden h-7 w-20 shrink-0 sm:block" />
      </div>
    </div>
  );
}
