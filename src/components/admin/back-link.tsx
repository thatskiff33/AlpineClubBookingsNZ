import Link from "next/link";

/**
 * Consistent "back to parent hub" affordance for admin drill-down leaf pages.
 *
 * Renders the same styled link the Booking Policies leaves established so every
 * hub leaf returns to a predictable *static* parent hub (not browser history —
 * important on kiosk/touch where there may be no history to go back to). Pass
 * the parent hub's route as `href` and its human name as `label`; the component
 * prepends the ← affordance and the shared underline styling.
 *
 * RULE (enforced): every admin drill-down leaf page must render `BackLink` to
 * its parent, and be covered by an enforcement suite. Statically renderable
 * leaves live in `src/lib/__tests__/admin-leaf-back-links.test.tsx`; the
 * client-gated leaves that fetch on mount live in the companion RTL suite
 * `src/lib/__tests__/admin-drilldown-back-links-client.test.tsx`. When you add a
 * leaf under an admin hub, add its BackLink here AND extend whichever suite fits
 * its render model — the frozen contract fails if a covered leaf loses its link.
 *
 * Dynamic-parent variant: a few drill-downs sit under a parent that is itself
 * dynamic (an `[id]` record page, or a caller-provided `returnTo`) rather than a
 * fixed hub. `BackLink` already accepts an arbitrary `href`/`label`, so those
 * pages need no new component — resolve the parent route (e.g.
 * `/admin/lodges/${id}`) and pass it as `href`. The static-hub case is the
 * common one; the dynamic-parent case is the documented exception.
 */
export function BackLink({
  href,
  label,
  prefetch,
}: {
  href: string;
  label: string;
  /**
   * Passed straight to `next/link`. Pass `false` on the rare leaf that is
   * reachable while its PARENT hub is feature-gated off (e.g. the Lodge Display
   * setup wizard, #2249): prefetching the parent would fire a background request
   * for a route that answers 404 in exactly that state. Everywhere else, leave
   * it alone — Next's default prefetch is what makes hub navigation feel instant.
   */
  prefetch?: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      className="text-sm font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
    >
      ← {label}
    </Link>
  );
}
