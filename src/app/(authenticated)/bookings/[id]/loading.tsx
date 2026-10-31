import { RouteLoading } from "@/components/route-loading";
import { Skeleton } from "@/components/ui/skeleton";

export default function BookingDetailLoading() {
  return (
    <RouteLoading label="Loading the booking…" className="mx-auto max-w-4xl space-y-4 px-4 py-8">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-9 w-36" />
      </div>
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </RouteLoading>
  );
}
