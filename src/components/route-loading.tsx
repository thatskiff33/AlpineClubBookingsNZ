import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type RouteLoadingProps = {
  /**
   * What a screen reader announces while the page streams in. Phrase it as the
   * thing arriving ("Loading bookings…"), not as an instruction.
   */
  label?: string;
  /** Classes for the skeleton's own layout box (spacing, width, padding). */
  className?: string;
  /** A page-shaped skeleton. Omitted, a generic heading-and-rows one is used. */
  children?: React.ReactNode;
};

/**
 * The shared shell of every `loading.tsx` (#4467).
 *
 * The skeleton blocks are decoration, so they sit inside an `aria-hidden` box;
 * what assistive technology gets is a polite live `status` region carrying a
 * visually hidden label. `aria-busy` is deliberately NOT set: on a live region it
 * tells a screen reader to hold its announcement until the region stops being
 * busy, which for a fallback that is simply replaced would be never.
 *
 * Colours come from the `Skeleton` primitive (`bg-primary/10`), which reads the
 * theme tokens, so the shell follows light and dark mode with the rest of the
 * app; the global `prefers-reduced-motion` guard freezes its pulse.
 */
export function RouteLoading({
  label = "Loading…",
  className,
  children,
}: RouteLoadingProps) {
  return (
    <div role="status" aria-live="polite" data-route-loading="">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className={cn("space-y-4", className)}>
        {children ?? <GenericPageSkeleton />}
      </div>
    </div>
  );
}

/** A page heading, a toolbar and a handful of rows: the shape of most screens. */
function GenericPageSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-12 w-full" />
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </>
  );
}
