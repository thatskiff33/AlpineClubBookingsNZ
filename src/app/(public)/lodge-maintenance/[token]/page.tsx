import type { Metadata } from "next";

import { LodgeMaintenanceReportClient } from "./lodge-maintenance-report-client";

/**
 * The unauthenticated QR page (#2780, owner decision 5).
 *
 * `(public)`, whose layout declares `force-dynamic` for the whole group, so this
 * page is never stored — the same reason `/pay/[token]` and
 * `/membership-cancellation/[token]` live here. The module gate is upstream in
 * `src/proxy.ts`, so with `maintenanceReports` off this address is a 404 before
 * this file runs.
 *
 * THIS SERVER COMPONENT DELIBERATELY NEVER TOUCHES `params`, and that is a
 * security choice rather than a simplification. A `params` value read here and
 * handed to the client component as a prop would be serialised into the RSC
 * payload — i.e. into a `<script>` in the delivered HTML — so the bearer token
 * would sit in the document as well as in the address bar. The client reads it
 * from the router instead (`useParams`), which derives from the URL the browser
 * already has, so the token is in exactly one place and is never rendered into an
 * attribute or into visible text. `/pay/[token]` takes the same approach.
 *
 * It also means this page renders identically for a valid and an invalid token:
 * the four gates are answered by the API, which returns one generic 404 for every
 * failure. There is nothing here to tell the two apart, which is the point.
 */

// The same title as the signed-in `/maintenance-report`, on purpose: it is the
// QR-code door to the same form. Change both together (#5217).
export const metadata: Metadata = {
  title: "Report a maintenance issue",
  robots: { index: false, follow: false },
};

export default function LodgeMaintenanceReportPage() {
  return <LodgeMaintenanceReportClient />;
}
