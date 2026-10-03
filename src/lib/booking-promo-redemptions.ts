/**
 * THE ONE READ of a booking's promo redemptions (#3826, epic #3813 C1).
 *
 * A booking may carry several promo codes — one `PromoRedemption` per code,
 * owner decision on #3492 — so `Booking.promoRedemptions` is a list. Every
 * reader goes through this module rather than indexing the relation itself, so
 * the order the codes apply in (the booker's order, D-3813-2) lives in exactly
 * one place (INV-SSOT-001). Since #3828 every reader states every code, so the
 * former one-code-only reader and its refusal are gone.
 *
 * Pure and dependency-free on purpose: it is imported by route handlers, email
 * composition and test doubles alike, and must not drag Prisma onto any of
 * their module graphs. (`ordinal-order` is the one import, and it imports
 * nothing.)
 *
 * WHILE THE `multiPromoCodes` MODULE SWITCH IS OFF a booking holds at most one
 * redemption (`redeemPromoCode` refuses a second), so every function here
 * returns exactly what the former one-to-one relation did.
 */

import { compareOrdinal } from "@/lib/ordinal-order";

/** The fields this module may order by, when a reader selected them. */
interface OrderableRedemption {
  applicationOrder?: number | null;
  id?: string | null;
}

/** Anything that carries a booking's redemptions, as Prisma loads them. */
export interface PromoRedemptionCarrier<T> {
  promoRedemptions?: readonly T[] | null;
}

/**
 * The booking's redemptions in the order they apply: the booker's
 * `applicationOrder` (D-3813-2), then `id` — the same order the night-adjustment
 * writer reads them in (`orderBy: [{ applicationOrder }, { id }]`,
 * `night-adjustment-write.ts`), so a reader and the writer never disagree about
 * which of two equal-order codes came first. A select that loaded neither
 * field keeps the database's order. A booking with no promotion — or a select
 * that did not load the relation — is an empty list, never null.
 */
export function bookingPromoRedemptions<T>(
  booking: PromoRedemptionCarrier<T> | null | undefined,
): T[] {
  const rows = booking?.promoRedemptions ?? [];
  // A select that did not ask for `applicationOrder` sorts as 0 throughout,
  // and one without `id` falls through to the database's order.
  const orderOf = (row: T) => (row as OrderableRedemption).applicationOrder ?? 0;
  const idOf = (row: T) => (row as OrderableRedemption).id ?? "";
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        orderOf(a.row) - orderOf(b.row) ||
        compareOrdinal(idOf(a.row), idOf(b.row)) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/**
 * The codes a booking carries, in application order, joined for display —
 * `null` when it carries none. With one code this is that code, byte for byte,
 * which is what every email and audit field held before #3826.
 */
export function bookingPromoCodeLabel(
  booking:
    | PromoRedemptionCarrier<{ promoCode?: { code: string } | null }>
    | null
    | undefined,
): string | null {
  const codes = bookingPromoRedemptions(booking)
    .map((redemption) => redemption.promoCode?.code)
    .filter((code): code is string => Boolean(code));
  return codes.length > 0 ? codes.join(", ") : null;
}
