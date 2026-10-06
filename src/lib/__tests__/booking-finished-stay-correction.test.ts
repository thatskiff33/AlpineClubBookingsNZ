import { describe, expect, it } from "vitest";

import {
  classifyFinishedStayChangeFeeRule,
  finishedStayNoticeDay,
} from "@/lib/booking-finished-stay-correction";
import {
  FINISHED_STAY_CORRECTION_FIELD_MESSAGE,
  FINISHED_STAY_CORRECTION_FUTURE_NIGHT_MESSAGE,
  resolveTargetDates,
  type BatchModifyInput,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";
import { daysUntilDate } from "@/lib/policies/cancellation";

/**
 * #3750: the finished-stay correction's own rules — the owner's change-fee rule
 * (decision record, 6 Oct 2026) and the window `resolveTargetDates` opens for an
 * officer-approved LOCKED_PERIOD change request on a stay that has finished.
 * Fixtures sit relative to the frozen suite clock (1 July 2026).
 */

function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

const TODAY = day("2026-07-01");

function makeBooking(status = "COMPLETED"): LoadedBookingForModify {
  return {
    status,
    checkIn: day("2026-06-10"),
    checkOut: day("2026-06-14"),
    guests: [
      { id: "g1", stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
      { id: "g2", stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
    ],
  } as unknown as LoadedBookingForModify;
}

function resolve(input: BatchModifyInput, booking = makeBooking()) {
  return resolveTargetDates({
    booking,
    role: "ADMIN",
    input,
    today: TODAY,
    finishedStayCorrection: true,
  });
}

const unchanged = {
  stored: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
  proposed: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
};

describe("finished-stay change-fee rule (#3750 owner decision)", () => {
  it("adding guests while every kept guest keeps their nights is add-only: no change fee", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 2,
        removedGuestCount: 0,
        remainingGuests: [unchanged, unchanged],
      }),
    ).toBe("ADD_ONLY_NO_FEE");
  });

  it("reads kept guests' nights, not whether the request mentioned stay ranges", () => {
    // The member's form resends every guest's range; a resent, identical range
    // must not turn an add into a same-day-fee change. Explicit night rows that
    // equal the contiguous range are the same nights.
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 1,
        removedGuestCount: 0,
        remainingGuests: [
          {
            stored: {
              stayStart: day("2026-06-10"),
              stayEnd: day("2026-06-12"),
              nights: [{ stayDate: day("2026-06-11") }, { stayDate: day("2026-06-10") }],
            },
            proposed: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-12") },
          },
        ],
      }),
    ).toBe("ADD_ONLY_NO_FEE");
  });

  it("a removal is charged as a same-day notice change", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 0,
        removedGuestCount: 1,
        remainingGuests: [unchanged],
      }),
    ).toBe("SAME_DAY_NOTICE");
  });

  it("a swap (a removal with an add) is charged as a same-day notice change", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 1,
        removedGuestCount: 1,
        remainingGuests: [unchanged],
      }),
    ).toBe("SAME_DAY_NOTICE");
  });

  it("an add that also moves a kept guest's nights is not add-only", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 1,
        removedGuestCount: 0,
        remainingGuests: [
          {
            stored: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-14") },
            proposed: { stayStart: day("2026-06-10"), stayEnd: day("2026-06-13") },
          },
        ],
      }),
    ).toBe("SAME_DAY_NOTICE");
  });

  it("a date or range change with nobody added is a same-day notice change", () => {
    expect(
      classifyFinishedStayChangeFeeRule({
        addedGuestCount: 0,
        removedGuestCount: 0,
        remainingGuests: [unchanged],
      }),
    ).toBe("SAME_DAY_NOTICE");
  });

  it("measures the notice period from the stay's own check-in, so it is exactly 0 days", () => {
    const booking = makeBooking();
    const noticeDay = finishedStayNoticeDay(booking);
    expect(noticeDay).toBe("2026-06-10");
    expect(daysUntilDate(booking.checkIn, noticeDay)).toBe(0);
  });
});

describe("resolveTargetDates — finished-stay correction window (#3750)", () => {
  it("admits a past guest add and reports the mode it engaged", () => {
    const dates = resolve({
      addGuests: [
        { firstName: "Late", lastName: "Guest", ageTier: "ADULT", isMember: false },
      ],
      notifyMember: true,
    });
    expect(dates.isFinishedStayCorrection).toBe(true);
    expect(dates.isInProgressEdit).toBe(false);
    expect(dates.newCheckIn.toISOString().slice(0, 10)).toBe("2026-06-10");
  });

  it("admits a change to the finished stay's check-in", () => {
    const dates = resolve({ checkIn: "2026-06-11" });
    expect(dates.checkInChanged).toBe(true);
    expect(dates.isFinishedStayCorrection).toBe(true);
  });

  it("refuses anything a change request cannot carry", () => {
    expect(() => resolve({ promoCode: "SUMMER" })).toThrow(
      FINISHED_STAY_CORRECTION_FIELD_MESSAGE,
    );
    expect(() =>
      resolve({ guestUpdates: [{ guestId: "g1", firstName: "A", lastName: "B" }] }),
    ).toThrow(FINISHED_STAY_CORRECTION_FIELD_MESSAGE);
    expect(() => resolve({ applyCreditCents: 0 })).toThrow(
      FINISHED_STAY_CORRECTION_FIELD_MESSAGE,
    );
  });

  it("refuses to reach a night on or after today", () => {
    expect(() => resolve({ checkOut: "2026-07-02" })).toThrow(
      FINISHED_STAY_CORRECTION_FUTURE_NIGHT_MESSAGE,
    );
    // Checking out today leaves every night before today, which is allowed.
    expect(resolve({ checkOut: "2026-07-01" }).isFinishedStayCorrection).toBe(true);
  });

  it("does not report the mode for a stay that has not finished", () => {
    const booking = {
      ...makeBooking("PAID"),
      checkIn: day("2026-06-29"),
      checkOut: day("2026-07-03"),
    } as LoadedBookingForModify;
    const dates = resolve({}, booking);
    expect(dates.isFinishedStayCorrection).toBe(false);
    expect(dates.isInProgressEdit).toBe(true);
  });

  it("keeps a member out entirely, flag or no flag", () => {
    expect(() =>
      resolveTargetDates({
        booking: makeBooking(),
        role: "USER",
        input: {},
        today: TODAY,
        finishedStayCorrection: true,
      }),
    ).toThrow("This booking has no future nights available for self-service changes");
  });
});
