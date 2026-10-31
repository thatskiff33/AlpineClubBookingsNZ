import { RouteLoading } from "@/components/route-loading";
import { Skeleton } from "@/components/ui/skeleton";

export default function BookLoading() {
  return (
    <RouteLoading label="Loading the booking form…" className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-5 w-72" />
      <Skeleton className="h-96 w-full" />
    </RouteLoading>
  );
}
