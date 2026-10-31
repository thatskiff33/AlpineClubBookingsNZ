"use client";

import { RouteError } from "@/components/route-error";

// The (finance) route group's error boundary (#4467). It renders inside the
// group's layout; everything it shows comes from the shared RouteError and the
// "finance" entry in src/lib/route-group-boundaries.ts.
export default function FinanceError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return <RouteError error={error} retry={retry} area="finance" />;
}
