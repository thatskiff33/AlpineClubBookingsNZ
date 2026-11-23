import { describe, expect, it } from "vitest";

import { addDaysDateOnly } from "@/lib/date-only";
import { nonMemberHoldEnd } from "@/lib/non-member-hold-end";

// #5407: the one definition of "check-in minus hold days" that booking create,
// the guest edit, a modification's settlement, a date change, an approved
// request's hold and the confirm-pending anchor share. Each case pins the
// arithmetic the copies it replaced wrote out by hand.
describe("nonMemberHoldEnd (#5407)", () => {
  it("is the check-in less the hold days, as the copies it replaced computed it", () => {
    const checkIn = new Date("2026-08-15T00:00:00.000Z");
    for (const holdDays of [0, 1, 7, 14, 30]) {
      expect(nonMemberHoldEnd(checkIn, holdDays).getTime()).toBe(
        checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000,
      );
    }
    expect(nonMemberHoldEnd(checkIn, 14).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("counts elapsed 24-hour spans, not club calendar days, across a daylight-saving change", () => {
    // New Zealand daylight saving starts on 27 September 2026. A calendar-day
    // step in the club's zone would land an hour away; the hold never did.
    const checkIn = new Date("2026-10-01T00:00:00.000Z");
    expect(nonMemberHoldEnd(checkIn, 7).toISOString()).toBe("2026-09-24T00:00:00.000Z");
  });

  it("matches the UTC calendar-day step the waitlist used, for every whole-day count", () => {
    // waitlist.ts stepped `addDaysDateOnly(checkIn, -holdDays)` before #5407.
    for (const iso of ["2026-04-06T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]) {
      const checkIn = new Date(iso);
      for (let holdDays = 0; holdDays <= 60; holdDays += 1) {
        expect(nonMemberHoldEnd(checkIn, holdDays).getTime()).toBe(addDaysDateOnly(checkIn, -holdDays).getTime());
      }
    }
  });

  it("returns a new instant and leaves the check-in untouched", () => {
    const checkIn = new Date("2026-08-15T00:00:00.000Z");
    const end = nonMemberHoldEnd(checkIn, 0);
    expect(end).not.toBe(checkIn);
    expect(end.getTime()).toBe(checkIn.getTime());
    expect(checkIn.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });
});
