import { describe, expect, it } from "vitest";
import { buildUnpaidConfirmedWholeLodgeWhere } from "@/lib/booking-payment-flow";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import {
  buildAdditionalOwedWhere,
  buildUnpaidFinishedStaysStatusWhere,
  buildUnpaidFinishedStaysWhere,
  buildUnsettledAdditionalFinishedStaysWhere,
} from "@/lib/unpaid-finished-stays";
import {
  buildUnpaidFinishedStaysHref,
  buildUnsettledAdditionalFinishedStaysHref,
} from "@/lib/unpaid-finished-stays-hrefs";

/**
 * The day these helpers are ASKED about. Every one of them is a pure function
 * of the day it is handed — none reads a clock or a zone — so a fixed calendar
 * day exercises them exactly as "today" did, and this suite no longer depends
 * on what day it is or on which zone names it (#3123).
 */
const GIVEN_DAY = parseDateOnly("2026-07-01");

// Shared predicate/deep link for the dashboard attention card (#1709) and the
// sidebar Needs Attention badge (#1731). If one of these assertions fails, the
// queue definition changed — update every consuming surface (and its docs)
// together.
describe("unpaid finished stays helpers", () => {
  it("matches non-deleted bookings still owing their price with check-out on or before the given day", () => {
    expect(buildUnpaidFinishedStaysWhere(GIVEN_DAY)).toEqual({
      deletedAt: null,
      checkOut: { lte: GIVEN_DAY },
      OR: [
        { status: "PAYMENT_PENDING" },
        // #4019: the shared classification includes proven uncaptured card
        // entry, but excludes receipts, invoices and unknown evidence.
        buildUnpaidConfirmedWholeLodgeWhere(),
      ],
    });
  });

  it("is the fragment the bookings-list unpaid=finished filter composes with the URL's check-out bound", () => {
    expect(buildUnpaidFinishedStaysWhere(GIVEN_DAY)).toMatchObject(
      buildUnpaidFinishedStaysStatusWhere(),
    );
  });

  it("keeps the cutoff inclusive of the given day only", () => {
    const where = buildUnpaidFinishedStaysWhere(GIVEN_DAY);
    const cutoff = (where.checkOut as { lte: Date }).lte;

    // A stay checking out ON the given day is finished; the next day's is not.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(GIVEN_DAY.getTime());
    expect(cutoff.getTime()).toBeLessThan(
      addDaysDateOnly(GIVEN_DAY, 1).getTime(),
    );
  });

  it("builds the bookings-list deep link both surfaces share", () => {
    const dayKey = formatDateOnly(GIVEN_DAY);

    expect(buildUnpaidFinishedStaysHref(dayKey)).toBe(
      `/admin/bookings?unpaid=finished&checkOutTo=${dayKey}`,
    );
  });
});

// Sibling queue (#1723 path 2): settled stays whose upward modification delta
// was never collected on the card additional-payment flow. Same drift rule as
// above — the dashboard card, the sidebar badge, and the bookings-list
// `additionalOwed` filter all share these helpers; if an assertion here fails,
// update every consuming surface (and its docs) together.
describe("unsettled finished-stay additions helpers", () => {
  it("matches settled bookings whose latest additional payment never succeeded", () => {
    // Mirrors the member-facing owed predicate (member dashboard / booking
    // detail): additionalAmountCents > 0 with additionalPaymentStatus not
    // SUCCEEDED — PENDING, FAILED, or null on legacy rows all count as owed.
    // PAYMENT_PENDING is deliberately absent from the status set so this
    // queue stays disjoint from the primary predicate above (the two counts
    // can be summed without double-counting a booking).
    expect(buildAdditionalOwedWhere()).toEqual({
      status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
      payment: {
        is: {
          additionalAmountCents: { gt: 0 },
          OR: [
            { additionalPaymentStatus: null },
            { additionalPaymentStatus: { not: "SUCCEEDED" } },
          ],
        },
      },
    });
  });

  it("scopes the queue to non-deleted bookings checked out on or before the given day", () => {
    expect(buildUnsettledAdditionalFinishedStaysWhere(GIVEN_DAY)).toEqual({
      deletedAt: null,
      checkOut: { lte: GIVEN_DAY },
      ...buildAdditionalOwedWhere(),
    });
  });

  it("stays disjoint from the primary unpaid-finished-stays predicate", () => {
    const additionsStatuses = (
      buildAdditionalOwedWhere().status as { in: string[] }
    ).in;
    // PAYMENT_PENDING is the primary queue's; the whole-lodge branch is CONFIRMED,
    // which the additions queue also names, but the shared whole-lodge rule
    // admits only absent payment or uncaptured PRIMARY attempts, never additions.
    const primaryStatuses = (
      buildUnpaidFinishedStaysWhere(GIVEN_DAY).OR as Array<{ status: string }>
    ).map((o) => o.status);

    expect(additionsStatuses).not.toContain("PAYMENT_PENDING");
    expect(primaryStatuses).toContain("PAYMENT_PENDING");
  });

  it("builds the bookings-list deep link both surfaces share", () => {
    const dayKey = formatDateOnly(GIVEN_DAY);

    expect(buildUnsettledAdditionalFinishedStaysHref(dayKey)).toBe(
      `/admin/bookings?additionalOwed=owed&checkOutTo=${dayKey}`,
    );
  });
});
