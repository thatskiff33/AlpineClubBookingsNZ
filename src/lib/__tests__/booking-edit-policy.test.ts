import { describe, expect, it } from "vitest";
import {
  bookingStayHasStarted,
  canModifyBookingStatusForRole,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";

describe("booking edit policy", () => {
  it("allows members to modify only active booking lifecycle statuses", () => {
    expect(canModifyBookingStatusForRole("PENDING", "MEMBER")).toBe(true);
    expect(canModifyBookingStatusForRole("CONFIRMED", "MEMBER")).toBe(true);
    expect(canModifyBookingStatusForRole("PAID", "MEMBER")).toBe(true);
    expect(canModifyBookingStatusForRole("COMPLETED", "MEMBER")).toBe(true);
    // #2266: members may edit their OWN drafts — the dashboard Resume journey.
    expect(canModifyBookingStatusForRole("DRAFT", "MEMBER")).toBe(true);
    expect(canModifyBookingStatusForRole("WAITLISTED", "MEMBER")).toBe(false);
  });

  it("allows admins to modify the additional future-booking statuses from phase 1", () => {
    expect(canModifyBookingStatusForRole("DRAFT", "ADMIN")).toBe(true);
    expect(canModifyBookingStatusForRole("WAITLISTED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatusForRole("WAITLIST_OFFERED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatusForRole("BUMPED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatusForRole("CANCELLED", "ADMIN")).toBe(false);
    expect(canModifyBookingStatusForRole("COMPLETED", "ADMIN")).toBe(true);
  });

  it("marks only active booking states for the full capacity/payment lifecycle", () => {
    expect(usesActiveBookingEditLifecycle("PENDING")).toBe(true);
    expect(usesActiveBookingEditLifecycle("CONFIRMED")).toBe(true);
    expect(usesActiveBookingEditLifecycle("PAID")).toBe(true);
    expect(usesActiveBookingEditLifecycle("COMPLETED")).toBe(true);
    expect(usesActiveBookingEditLifecycle("DRAFT")).toBe(false);
    expect(usesActiveBookingEditLifecycle("WAITLISTED")).toBe(false);
  });

  // #3123 - the club's day is now an INPUT, so these cases state it outright
  // instead of pinning the process clock and letting the environment's zone
  // project it. That is strictly more determinate: the old form passed only
  // because `APP_TIME_ZONE` happened to be Pacific/Auckland.
  it("allows in-progress paid/completed stays from the club's tomorrow while locking check-in", () => {
    const paidPolicy = getBookingEditPolicy({
      status: "PAID",
      role: "MEMBER",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
      today: new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(paidPolicy.canModify).toBe(true);
    expect(paidPolicy.mode).toBe("in-progress");
    expect(paidPolicy.editableFrom?.toISOString().slice(0, 10)).toBe("2026-08-22");
    expect(paidPolicy.checkInEditable).toBe(false);

    const completedPolicy = getBookingEditPolicy({
      status: "COMPLETED",
      role: "MEMBER",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
      today: new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(completedPolicy.canModify).toBe(true);
    expect(completedPolicy.mode).toBe("in-progress");
  });

  it("keeps a PAID stay editable/extendable on its check-out day (#2029)", () => {
    // The club's today IS the check-out day.
    const policy = getBookingEditPolicy({
      status: "PAID",
      role: "MEMBER",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
      today: new Date("2026-08-24T00:00:00.000Z"),
    });

    // The booking is still PAID this whole day and must stay amendable so guests
    // at the lodge on their check-out morning can extend.
    expect(policy.today.toISOString().slice(0, 10)).toBe("2026-08-24");
    expect(policy.canModify).toBe(true);
    expect(policy.mode).toBe("in-progress");
    expect(policy.checkInEditable).toBe(false);
    // Extending moves check-out to >= tomorrow, which adds the check-out-day
    // night and beyond; today and earlier stay locked.
    expect(policy.editableFrom?.toISOString().slice(0, 10)).toBe("2026-08-25");
  });

  it("locks the stay only once the whole check-out day has passed (#2029)", () => {
    // The day AFTER check-out at the club.
    const policy = getBookingEditPolicy({
      status: "PAID",
      role: "MEMBER",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
      today: new Date("2026-08-25T00:00:00.000Z"),
    });

    expect(policy.today.toISOString().slice(0, 10)).toBe("2026-08-25");
    expect(policy.canModify).toBe(false);
    expect(policy.mode).toBeNull();
  });

  it("locks fully past completed stays", () => {
    const policy = getBookingEditPolicy({
      status: "COMPLETED",
      role: "MEMBER",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
      today: new Date("2026-08-26T00:00:00.000Z"),
    });

    expect(policy.canModify).toBe(false);
    expect(policy.mode).toBeNull();
  });

  it("answers from the club day it was GIVEN, and from nothing else (#3123)", () => {
    // The whole point of the migration: two calls differing ONLY in the club
    // day must classify the SAME booking differently, and neither the process
    // clock nor `APP_TIME_ZONE` can influence either answer.
    const base = {
      status: "PAID",
      role: "MEMBER" as const,
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
    };
    const onCheckOutDay = getBookingEditPolicy({
      ...base,
      today: new Date("2026-08-24T00:00:00.000Z"),
    });
    const dayAfter = getBookingEditPolicy({
      ...base,
      today: new Date("2026-08-25T00:00:00.000Z"),
    });

    expect(onCheckOutDay.today.toISOString()).toBe("2026-08-24T00:00:00.000Z");
    expect(dayAfter.today.toISOString()).toBe("2026-08-25T00:00:00.000Z");
    expect(onCheckOutDay.canModify).toBe(true);
    expect(dayAfter.canModify).toBe(false);
  });
});

describe("bookingStayHasStarted (#2029)", () => {
  it("treats a stay whose check-in is the club's today or earlier as started", () => {
    // #3123 - the club's day is supplied, not projected from the process clock
    // through `APP_TIME_ZONE`.
    const clubTodayDateOnly = new Date("2026-08-24T00:00:00.000Z");

    // Check-in yesterday (mid-stay) and today (check-in day / check-out day of a
    // one-night stay) are both "started".
    expect(bookingStayHasStarted(new Date("2026-08-23T00:00:00.000Z"), clubTodayDateOnly)).toBe(true);
    expect(bookingStayHasStarted(new Date("2026-08-24T00:00:00.000Z"), clubTodayDateOnly)).toBe(true);
    // A future check-in has not started.
    expect(bookingStayHasStarted(new Date("2026-08-25T00:00:00.000Z"), clubTodayDateOnly)).toBe(false);
  });

  it("moves its answer with the CLUB's day and with nothing else (#3123)", () => {
    // The same stay judged on two adjacent club days. Under the old default both
    // answers came from `APP_TIME_ZONE`, so a club behind its container was told
    // its stay had started a day early and lost a self-service cancel it was
    // still entitled to.
    const checkIn = new Date("2026-07-18T00:00:00.000Z");
    expect(bookingStayHasStarted(checkIn, new Date("2026-07-17T00:00:00.000Z"))).toBe(false);
    expect(bookingStayHasStarted(checkIn, new Date("2026-07-18T00:00:00.000Z"))).toBe(true);
  });
});

describe("booking-detail canCancel mirror (#2029)", () => {
  // Mirrors the composite the booking-detail page uses so the Cancel button
  // never shows for a self-service actor on a started stay (no button that 400s),
  // while a Full Admin keeps it.
  const CANCELLABLE = ["PAYMENT_PENDING", "CONFIRMED", "PAID", "PENDING", "WAITLISTED", "WAITLIST_OFFERED"];
  function canCancelUI(opts: {
    canManageBooking: boolean;
    canAdminEditBookings: boolean;
    isDeleted: boolean;
    isAdmin: boolean;
    stayHasStarted: boolean;
    status: string;
  }) {
    return (
      (opts.canManageBooking || opts.canAdminEditBookings) &&
      !opts.isDeleted &&
      (opts.isAdmin || !opts.stayHasStarted) &&
      CANCELLABLE.includes(opts.status)
    );
  }

  it("hides Cancel for a member (owner) on a started PAID stay", () => {
    expect(
      canCancelUI({
        canManageBooking: true,
        canAdminEditBookings: false,
        isDeleted: false,
        isAdmin: false,
        stayHasStarted: true,
        status: "PAID",
      }),
    ).toBe(false);
  });

  it("hides Cancel for a Booking Officer (not Full Admin) on a started stay", () => {
    expect(
      canCancelUI({
        canManageBooking: false,
        canAdminEditBookings: true,
        isDeleted: false,
        isAdmin: false,
        stayHasStarted: true,
        status: "PAID",
      }),
    ).toBe(false);
  });

  it("keeps Cancel for a Full Admin on a started stay", () => {
    expect(
      canCancelUI({
        canManageBooking: true,
        canAdminEditBookings: true,
        isDeleted: false,
        isAdmin: true,
        stayHasStarted: true,
        status: "PAID",
      }),
    ).toBe(true);
  });

  it("keeps Cancel for a member on a future (not-started) stay", () => {
    expect(
      canCancelUI({
        canManageBooking: true,
        canAdminEditBookings: false,
        isDeleted: false,
        isAdmin: false,
        stayHasStarted: false,
        status: "PAID",
      }),
    ).toBe(true);
  });
});

describe("booking edit policy — admin override (issue #1668)", () => {
  // Anchor "now" mid-stay for the in-progress case, well after the fully-past
  // stays so those refuse without the flag.
  // #3123 - the club's day travels WITH each fixture instead of being pinned on
  // the process clock and projected through `APP_TIME_ZONE`. Same days as
  // before: mid-stay for IN_PROGRESS, well past for FULLY_PAST.
  const IN_PROGRESS = {
    checkIn: new Date("2026-08-20T00:00:00.000Z"),
    checkOut: new Date("2026-08-24T00:00:00.000Z"),
    today: new Date("2026-08-23T00:00:00.000Z"),
  };
  const FULLY_PAST = {
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-05T00:00:00.000Z"),
    today: new Date("2026-08-26T00:00:00.000Z"),
  };

  it("unlocks an in-progress PAID stay for an admin override", () => {
    const withOverride = getBookingEditPolicy({
      status: "PAID",
      role: "ADMIN",
      ...IN_PROGRESS,
      adminOverride: true,
    });
    expect(withOverride.canModify).toBe(true);
    expect(withOverride.mode).toBe("admin-override");
    expect(withOverride.checkInEditable).toBe(true);
    expect(withOverride.editableFrom).toBeNull();

    // Same inputs WITHOUT the flag stay the in-progress branch (check-in locked).
    const withoutOverride = getBookingEditPolicy({
      status: "PAID",
      role: "ADMIN",
      ...IN_PROGRESS,
    });
    expect(withoutOverride.mode).toBe("in-progress");
    expect(withoutOverride.checkInEditable).toBe(false);

  });

  it("unlocks a fully-past COMPLETED stay for an admin override", () => {
    const withOverride = getBookingEditPolicy({
      status: "COMPLETED",
      role: "ADMIN",
      ...FULLY_PAST,
      adminOverride: true,
    });
    expect(withOverride.canModify).toBe(true);
    expect(withOverride.mode).toBe("admin-override");
    expect(withOverride.checkInEditable).toBe(true);

    // Pin the fully-past non-override refusal for the same inputs.
    const withoutOverride = getBookingEditPolicy({
      status: "COMPLETED",
      role: "ADMIN",
      ...FULLY_PAST,
    });
    expect(withoutOverride.canModify).toBe(false);
    expect(withoutOverride.mode).toBeNull();

  });

  it("unlocks a fully-past PAID stay for an admin override", () => {
    const withOverride = getBookingEditPolicy({
      status: "PAID",
      role: "ADMIN",
      ...FULLY_PAST,
      adminOverride: true,
    });
    expect(withOverride.canModify).toBe(true);
    expect(withOverride.mode).toBe("admin-override");
    expect(withOverride.checkInEditable).toBe(true);

    const withoutOverride = getBookingEditPolicy({
      status: "PAID",
      role: "ADMIN",
      ...FULLY_PAST,
    });
    expect(withoutOverride.canModify).toBe(false);
    expect(withoutOverride.mode).toBeNull();

  });

  it("ignores the override flag for a non-admin role (byte-for-byte fall-through)", () => {
    const withFlag = getBookingEditPolicy({
      status: "COMPLETED",
      role: "MEMBER",
      ...FULLY_PAST,
      adminOverride: true,
    });
    const withoutFlag = getBookingEditPolicy({
      status: "COMPLETED",
      role: "MEMBER",
      ...FULLY_PAST,
    });
    expect(withFlag).toEqual(withoutFlag);
    expect(withFlag.canModify).toBe(false);
    expect(withFlag.mode).toBeNull();

  });

  it("still refuses an override for an ineligible status (CANCELLED)", () => {
    const policy = getBookingEditPolicy({
      status: "CANCELLED",
      role: "ADMIN",
      ...FULLY_PAST,
      adminOverride: true,
    });
    expect(policy.canModify).toBe(false);
    expect(policy.mode).toBeNull();
    expect(policy.reason).toBe(
      "This booking cannot be modified in its current status",
    );

  });
});
