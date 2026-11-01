/**
 * The deep links behind the unpaid-finished-stays and unsettled-additions
 * queues (#1709, #1723, #2350): the bookings-list URLs the admin dashboard
 * cards and the sidebar Needs Attention badges point at.
 *
 * Split out of `unpaid-finished-stays.ts` (#4019 review): that module builds
 * the queues' Prisma `where` fragments, and since #4019 it composes the
 * whole-lodge "not yet paid" rule from `booking-payment-flow.ts`, whose graph
 * reaches the Prisma runtime. The client-side admin sidebar needs only these
 * strings, so they live here with NO imports at all, and the sidebar never
 * carries the server-side predicate graph. The `where` builders the links
 * mirror stay in `unpaid-finished-stays.ts`; keep the two in step.
 */

/**
 * Deep link to the bookings list pre-filtered to the unpaid-finished-stays
 * queue via the Check Out range filter. `todayKey` is the NZ date-only key
 * (YYYY-MM-DD).
 */
export function buildUnpaidFinishedStaysHref(todayKey: string): string {
  return `/admin/bookings?unpaid=finished&checkOutTo=${todayKey}`;
}

/**
 * Deep link to the bookings list pre-filtered to the unsettled finished-stay
 * additions via the `additionalOwed` filter plus the Check Out range filter.
 */
export function buildUnsettledAdditionalFinishedStaysHref(
  todayKey: string,
): string {
  return `/admin/bookings?additionalOwed=owed&checkOutTo=${todayKey}`;
}

/**
 * Deep link covering BOTH halves of the unsettled-additions queue — every
 * booking with an uncollected addition, whenever it stays. Used by the sidebar
 * badge and the dashboard card, whose split label ("N upcoming, M finished")
 * names the two halves while the one link shows all of them; the bookings list
 * has no "upcoming only" filter to deep-link to, and inventing one to express a
 * split the list already sorts by check-out would be the worse trade.
 */
export function buildUnsettledAdditionalStaysHref(): string {
  return "/admin/bookings?additionalOwed=owed";
}
