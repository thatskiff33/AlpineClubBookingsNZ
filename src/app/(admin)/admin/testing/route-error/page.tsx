import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import {
  ROUTE_ERROR_PROBE_COOKIE,
  ROUTE_ERROR_PROBE_HEADING,
  ROUTE_ERROR_PROBE_MESSAGE,
  routeErrorProbeOutcome,
} from "@/lib/route-error-probe";
import { isRealProductionRuntime } from "@/lib/xero-mock-endpoint";

/**
 * TEST-ONLY: the admin page the route-group error-boundary E2E makes fail on
 * purpose (#4467). A 404 in a real production runtime; see
 * `src/lib/route-error-probe.ts` for the gate and the cookie toggle.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: ROUTE_ERROR_PROBE_HEADING,
  robots: { index: false, follow: false },
};

export default async function RouteErrorProbePage() {
  const outcome = await routeErrorProbeOutcome({
    realProductionRuntime: isRealProductionRuntime(),
    readCookie: async () =>
      (await cookies()).get(ROUTE_ERROR_PROBE_COOKIE)?.value,
  });

  if (outcome === "absent") notFound();
  if (outcome === "throw") throw new Error(ROUTE_ERROR_PROBE_MESSAGE);

  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold text-foreground">
        {ROUTE_ERROR_PROBE_HEADING}
      </h1>
      <p className="text-sm text-muted-foreground">
        This test-only page rendered normally. It exists so the end-to-end suite
        can make an admin page fail and check the admin error screen recovers.
      </p>
    </div>
  );
}
