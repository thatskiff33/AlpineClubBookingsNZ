import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { guardAdminLayout } from "@/lib/admin-layout-guard";
import {
  ROUTE_ERROR_PROBE_COOKIE,
  ROUTE_ERROR_PROBE_HEADING,
  ROUTE_ERROR_PROBE_MESSAGE,
  ROUTE_ERROR_PROBE_THROW,
} from "@/lib/route-error-probe";
import { isRealProductionRuntime } from "@/lib/xero-mock-endpoint";

/**
 * TEST-ONLY: the admin page the route-group error-boundary E2E makes fail on
 * purpose (#4467). See `src/lib/route-error-probe.ts` for why the three steps
 * below run in exactly this order: production gate, admin guard, cookie.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: ROUTE_ERROR_PROBE_HEADING,
  robots: { index: false, follow: false },
};

export default async function RouteErrorProbePage() {
  // 1. Before any await: a real production runtime gets a real 404.
  if (isRealProductionRuntime()) notFound();

  // 2. The page guards itself: the admin layout's guard does not stop a child
  // segment from running (Next's authentication guide, "Layouts and auth checks").
  const guard = await guardAdminLayout();
  if (guard.outcome === "redirect") redirect(guard.destination);

  // 3. Only an admitted admin, outside production, reaches the toggle.
  const toggle = (await cookies()).get(ROUTE_ERROR_PROBE_COOKIE)?.value;
  if (toggle === ROUTE_ERROR_PROBE_THROW) {
    throw new Error(ROUTE_ERROR_PROBE_MESSAGE);
  }

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
