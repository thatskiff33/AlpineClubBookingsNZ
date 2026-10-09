/**
 * #3954 (`INV-PAY-120`, review round 4): the booking-vs-Xero repair pass's
 * running total of what booking edits refunded leaves out what an unpaid ask
 * took of a reduction - money nobody paid, so nothing was refunded for it - or
 * it would read a later refund request's money as already accounted for.
 */
import { describe, expect, it } from "vitest";

import { getKnownModificationRefundTotalCents } from "@/lib/xero-booking-repair-analysis";
import type { BookingRepairRecord } from "@/lib/xero-booking-repair-types";

function bookingWith(modifications: Array<{ priceDiffCents: number; newData: unknown }>): BookingRepairRecord {
  return {
    modifications: modifications.map((modification, index) => ({
      id: `mod_${index}`,
      changeFeeCents: 0,
      ...modification,
    })),
  } as unknown as BookingRepairRecord;
}

describe("getKnownModificationRefundTotalCents", () => {
  it("MUTATION: an $80 reduction whose first $50 cancelled an unpaid ask refunded only $30", () => {
    expect(
      getKnownModificationRefundTotalCents(
        bookingWith([
          { priceDiffCents: 5_000, newData: {} },
          { priceDiffCents: -8_000, newData: { unpaidAskOffsetCents: 5_000 } },
        ]),
      ),
    ).toBe(3_000);
  });

  it("a reduction the ask absorbed whole refunded nothing; an ordinary one, all of it", () => {
    expect(
      getKnownModificationRefundTotalCents(
        bookingWith([
          { priceDiffCents: -5_000, newData: { unpaidAskOffsetCents: 5_000 } },
          { priceDiffCents: -2_000, newData: {} },
        ]),
      ),
    ).toBe(2_000);
  });
});
