import { RouteLoading } from "@/components/route-loading";
import { Skeleton } from "@/components/ui/skeleton";

export default function BookingsLoading() {
  return (
    <RouteLoading label="Loading your bookings…" className="mx-auto max-w-4xl space-y-4 px-4 py-8">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-9 w-32" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </RouteLoading>
  );
}
