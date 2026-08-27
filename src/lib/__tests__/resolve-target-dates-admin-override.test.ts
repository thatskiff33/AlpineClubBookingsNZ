import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-error";
import {
  GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE,
  resolveTargetDates,
  type BatchModifyInput,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";

// resolveTargetDates is a pure function; only booking.status/checkIn/checkOut and
// the guest envelopes are read, so a minimal cast fixture is sufficient.
function makeBooking(
  status: string,
  checkIn: string,
  checkOut: string,
): LoadedBookingForModify {
  return {
    status,
    checkIn: new Date(`${checkIn}T00:00:00.000Z`),
    checkOut: new Date(`${checkOut}T00:00:00.000Z`),
    guests: [
      {
        id: "g1",
        stayStart: new Date(`${checkIn}T00:00:00.000Z`),
        stayEnd: new Date(`${checkOut}T00:00:00.000Z`),
      },
    ],
  } as unknown as LoadedBookingForModify;
}

describe("resolveTargetDates admin override (issue #1668)", () => {
  it("lets an admin override move the check-in of an in-progress booking", () => {
    // #3123 - the club's day, stated outright. It was a process-clock pin
    // projected through `APP_TIME_ZONE`, which is exactly the authority this
    // migration removed.
    const clubTodayDateOnly = new Date("2026-08-23T00:00:00.000Z");

    const booking = makeBooking("PAID", "2026-08-20", "2026-08-24");
    const input: BatchModifyInput = {
      checkIn: "2026-08-18",
      checkOut: "2026-08-22",
      adminOverride: true,
      pricingMode: "recalculate",
    };

    const result = resolveTargetDates({ booking, role: "ADMIN", input, today: clubTodayDateOnly });

    // admin-override mode is NOT in-progress, so the check-in lock is lifted.
    expect(result.isInProgressEdit).toBe(false);
    expect(result.checkInChanged).toBe(true);
    expect(result.newCheckIn.toISOString().slice(0, 10)).toBe("2026-08-18");
    expect(result.newCheckOut.toISOString().slice(0, 10)).toBe("2026-08-22");
  });

  it("lets an admin override move a fully-past booking", () => {
    // #3123 - the club's day, stated outright. It was a process-clock pin
    // projected through `APP_TIME_ZONE`, which is exactly the authority this
    // migration removed.
    const clubTodayDateOnly = new Date("2026-08-26T00:00:00.000Z");

    const booking = makeBooking("COMPLETED", "2026-08-01", "2026-08-05");
    const input: BatchModifyInput = {
      checkIn: "2026-08-10",
      checkOut: "2026-08-14",
      adminOverride: true,
      pricingMode: "recalculate",
    };

    const result = resolveTargetDates({ booking, role: "ADMIN", input, today: clubTodayDateOnly });
    expect(result.newCheckIn.toISOString().slice(0, 10)).toBe("2026-08-10");
    expect(result.newCheckOut.toISOString().slice(0, 10)).toBe("2026-08-14");
    expect(result.checkInChanged).toBe(true);
  });

  it("still locks the check-in for a member editing an in-progress booking (no flag)", () => {
    // #3123 - the club's day, stated outright. It was a process-clock pin
    // projected through `APP_TIME_ZONE`, which is exactly the authority this
    // migration removed.
    const clubTodayDateOnly = new Date("2026-08-23T00:00:00.000Z");

    const booking = makeBooking("PAID", "2026-08-20", "2026-08-24");
    const input: BatchModifyInput = { checkIn: "2026-08-18", checkOut: "2026-08-24" };

    expect(() => resolveTargetDates({ booking, role: "USER", input, today: clubTodayDateOnly })).toThrow(
      "Check-in cannot be changed for an in-progress booking",
    );
  });

  it("still refuses a member editing a fully-past booking (no flag)", () => {
    // #3123 - the club's day, stated outright. It was a process-clock pin
    // projected through `APP_TIME_ZONE`, which is exactly the authority this
    // migration removed.
    const clubTodayDateOnly = new Date("2026-08-26T00:00:00.000Z");

    const booking = makeBooking("COMPLETED", "2026-08-01", "2026-08-05");
    const input: BatchModifyInput = { checkIn: "2026-08-10", checkOut: "2026-08-14" };

    expect(() => resolveTargetDates({ booking, role: "USER", input, today: clubTodayDateOnly })).toThrow(
      ApiError,
    );
  });

  it("lets a MEMBER extend a still-PAID booking on its check-out day (#2029)", () => {
    // #3123 - the club's day, stated outright. It was a process-clock pin
    // projected through `APP_TIME_ZONE`, which is exactly the authority this
    // migration removed.
    const clubTodayDateOnly = new Date("2026-08-24T00:00:00.000Z");

    const booking = makeBooking("PAID", "2026-08-20", "2026-08-24");
    // Guest still at the lodge extends their stay by two nights.
    const input: BatchModifyInput = { checkOut: "2026-08-26" };

    const result = resolveTargetDates({ booking, role: "USER", input, today: clubTodayDateOnly });

    expect(result.isInProgressEdit).toBe(true);
    // Check-in stays locked to its original value; only the tail extends.
    expect(result.checkInChanged).toBe(false);
    expect(result.newCheckIn.toISOString().slice(0, 10)).toBe("2026-08-20");
    expect(result.newCheckOut.toISOString().slice(0, 10)).toBe("2026-08-26");
    expect(result.datesChanged).toBe(true);
  });

  it("refuses a MEMBER trying to move an in-progress booking's tail into the past (#2029 boundary)", () => {
    // #3123 - the club's day, stated outright. It was a process-clock pin
    // projected through `APP_TIME_ZONE`, which is exactly the authority this
    // migration removed.
    const clubTodayDateOnly = new Date("2026-08-24T00:00:00.000Z");

    const booking = makeBooking("PAID", "2026-08-20", "2026-08-24");
    // Trying to pull check-out back to today (locked) is rejected.
    const input: BatchModifyInput = { checkOut: "2026-08-24" };

    expect(() => resolveTargetDates({ booking, role: "USER", input, today: clubTodayDateOnly })).toThrow(
      "NZ today and earlier are locked for self-service changes",
    );
  });

  it("ignores the override flag for a non-admin role (cannot self-drive an override)", () => {
    // #3123 - the club's day, stated outright. It was a process-clock pin
    // projected through `APP_TIME_ZONE`, which is exactly the authority this
    // migration removed.
    const clubTodayDateOnly = new Date("2026-08-26T00:00:00.000Z");

    const booking = makeBooking("COMPLETED", "2026-08-01", "2026-08-05");
    const input: BatchModifyInput = {
      checkIn: "2026-08-10",
      checkOut: "2026-08-14",
      adminOverride: true,
      pricingMode: "recalculate",
    };

    // role USER carrying the flag falls through to the normal fully-past refusal.
    expect(() => resolveTargetDates({ booking, role: "USER", input, today: clubTodayDateOnly })).toThrow(
      ApiError,
    );
  });
});

describe("resolveTargetDates #2337: placeholder→member link on a mid-stay booking", () => {
  it("REFUSES a link on an in-progress (mid-stay) booking — the silent-$0 re-rate the feature exists to prevent", () => {
    // #3123 - the club's day, stated outright. It was a process-clock pin
    // projected through `APP_TIME_ZONE`, which is exactly the authority this
    // migration removed.
    const clubTodayDateOnly = new Date("2026-08-23T00:00:00.000Z");

    const booking = makeBooking("PAID", "2026-08-20", "2026-08-24");
    const input: BatchModifyInput = {
      linkGuestToMember: [{ guestId: "g1", memberId: "member-9" }],
    };

    expect(() => resolveTargetDates({ booking, role: "ADMIN", input, today: clubTodayDateOnly })).toThrow(
      GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE,
    );
  });

  it("does NOT fire the in-progress link refusal for a FUTURE (pre-stay) booking — that link re-rates correctly on the recalculate path", () => {
    // #3123 - the club's day, stated outright. It was a process-clock pin
    // projected through `APP_TIME_ZONE`, which is exactly the authority this
    // migration removed.
    const clubTodayDateOnly = new Date("2026-08-11T00:00:00.000Z");

    // Check-in is still in the future, so the edit is NOT in-progress; the link
    // is allowed here and re-rates through the full recalculate pricing pass.
    const booking = makeBooking("CONFIRMED", "2026-08-20", "2026-08-24");
    const input: BatchModifyInput = {
      linkGuestToMember: [{ guestId: "g1", memberId: "member-9" }],
    };

    const result = resolveTargetDates({ booking, role: "ADMIN", input, today: clubTodayDateOnly });
    expect(result.isInProgressEdit).toBe(false);
  });
});
