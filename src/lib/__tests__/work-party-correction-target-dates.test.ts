import { describe, expect, it } from "vitest";

import {
  resolveTargetDates,
  type BatchModifyInput,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";

/**
 * Fork triyder/AlpineClubBookingsNZ#127/triyder/AlpineClubBookingsNZ#130: `resolveTargetDates` under the officer's work-party
 * correction on a started stay. The stay is priced whole (not an in-progress
 * edit), so the promotion can re-run over every night, and no date can move.
 * Every other edit of the same stay keeps the in-progress promo refusal. Today
 * is the frozen 1 July 2026.
 */
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const TODAY = day("2026-07-01");

const started = {
  status: "PAID",
  checkIn: day("2026-06-29"),
  checkOut: day("2026-07-03"),
  guests: [{ id: "g1", stayStart: day("2026-06-29"), stayEnd: day("2026-07-03") }],
} as unknown as LoadedBookingForModify;

const promoOnly: BatchModifyInput = { promoCodes: [{ code: "WORKPARTY-X" }], notifyMember: false };

function resolve(input: BatchModifyInput, workPartyCorrection: boolean) {
  return resolveTargetDates({ booking: started, role: "ADMIN", input, today: TODAY, workPartyCorrection });
}

describe("resolveTargetDates — work-party correction on a started stay", () => {
  it("prices the started stay whole, with its dates unchanged", () => {
    expect(resolve(promoOnly, true)).toMatchObject({
      isInProgressEdit: false,
      editableFrom: null,
      newCheckIn: started.checkIn,
      newCheckOut: started.checkOut,
      datesChanged: false,
    });
  });

  it("refuses any date change in the mode", () => {
    expect(() => resolve({ ...promoOnly, checkOut: "2026-07-04" }, true)).toThrow(
      "A work-party correction cannot change a started stay's dates.",
    );
  });

  it("leaves every other edit of the stay in progress, refusing a promo change", () => {
    expect(() => resolve(promoOnly, false)).toThrow(
      "Promo code changes are not available for in-progress bookings",
    );
  });
});
