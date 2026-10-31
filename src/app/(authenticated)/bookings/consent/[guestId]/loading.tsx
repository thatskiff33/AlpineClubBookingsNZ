import { RouteLoading } from "@/components/route-loading";
import { Skeleton } from "@/components/ui/skeleton";

export default function DelegateConsentLoading() {
  return (
    <RouteLoading label="Loading the consent request…" className="mx-auto max-w-2xl space-y-6">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-72 w-full" />
    </RouteLoading>
  );
}
