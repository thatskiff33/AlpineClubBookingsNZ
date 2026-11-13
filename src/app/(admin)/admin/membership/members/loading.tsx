import { RouteLoading } from "@/components/route-loading";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminMembersLoading() {
  return (
    <RouteLoading label="Loading members…" className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-12 w-full" />
      {Array.from({ length: 10 }).map((_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </RouteLoading>
  );
}
