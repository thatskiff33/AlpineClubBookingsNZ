import { describe, expect, it } from "vitest";
import {
  buildBookingMemberNightConflictMessage,
  buildBookingMemberNightConflictSummary,
  describeBookingMemberNightConflictBooking,
  describeBookingMemberNightConflictNextStep,
  describeBookingMemberNightConflictNights,
  type BookingMemberNightConflictCopyInput,
} from "@/lib/booking-member-night-conflict-messages";
import { formatClubDate, requireCalendarDate } from "@/lib/club-time";

// #2250 — the already-booked copy must say WHO is already booked, WHICH nights,
// and WHAT to do next, without telling a viewer about a booking they are not
// entitled to see, and without offering advice the reader cannot act on.

function conflict(
  overrides: Partial<BookingMemberNightConflictCopyInput> = {},
): BookingMemberNightConflictCopyInput {
  return {
    memberName: "Alice Smith",
    conflictingNights: ["2026-06-01", "2026-06-02"],
    bookingStatus: "PAYMENT_PENDING",
    bookingOwnerName: "Bob Jones",
    isOwnBooking: false,
    canOpenBooking: false,
    canSelfRemove: false,
    isSelfGuest: false,
    ...overrides,
  };
}

describe("buildBookingMemberNightConflictMessage", () => {
  it("names the person, the nights, and what to do about somebody else's booking", () => {
    const message = buildBookingMemberNightConflictMessage([conflict()]);

    expect(message).toContain("Alice Smith");
    expect(message).toContain("1 Jun 2026 and 2 Jun 2026");
    expect(message).toContain("Ask whoever made that booking");
  });

  it("stays flow-neutral by default and only offers other dates when the reader picks them", () => {
    // Every producer routes through getBookingMemberNightConflictResponse,
    // including the admin booking-request approve/hold/send-quote routes. An
    // admin approving a request cannot "choose different dates".
    for (const viewer of [
      conflict(),
      conflict({ canOpenBooking: true }),
      conflict({ isOwnBooking: true, canOpenBooking: true }),
      conflict({
        canSelfRemove: true,
        isSelfGuest: true,
        canOpenBooking: true,
      }),
    ]) {
      expect(buildBookingMemberNightConflictMessage([viewer])).not.toContain(
        "choose different dates",
      );
      expect(
        buildBookingMemberNightConflictMessage([viewer], {
          canChooseDifferentDates: true,
        }),
      ).toContain("choose different dates");
    }
  });

  it("keeps the multi-person next step flow-neutral too", () => {
    const conflicts = [
      conflict({ conflictingNights: ["2026-06-02"] }),
      conflict({ memberName: "Cara Lee", conflictingNights: ["2026-06-01"] }),
    ];

    expect(buildBookingMemberNightConflictMessage(conflicts)).not.toContain(
      "choose different dates",
    );
    expect(
      buildBookingMemberNightConflictMessage(conflicts, {
        canChooseDifferentDates: true,
      }),
    ).toContain("choose different dates");
  });

  it("addresses the member in the second person when they can take themselves off", () => {
    const message = buildBookingMemberNightConflictMessage([
      conflict({ canSelfRemove: true, isSelfGuest: true, canOpenBooking: true }),
    ]);

    expect(message).toContain("You are already on another booking");
    expect(message).toContain("1 Jun 2026 and 2 Jun 2026");
    expect(message).toContain("Take yourself off that booking");
  });

  it("addresses the member directly when the clash is their OWN earlier booking", () => {
    // The commonest clash of all: the member against a booking they made
    // themselves. canSelfRemove is false there (self-removal is for somebody
    // else's booking), so keying the second person off it narrated the member
    // to their own face — "Alice Smith is already on a booking…".
    const message = buildBookingMemberNightConflictMessage([
      conflict({
        isSelfGuest: true,
        isOwnBooking: true,
        canOpenBooking: true,
        canSelfRemove: false,
      }),
    ]);

    expect(message).toContain("You are already on another booking");
    expect(message).not.toContain("Alice Smith");
    expect(message).toContain("Open that booking and change it");
  });

  it("keeps the third person when the clashing place belongs to somebody else on the viewer's own booking", () => {
    // The viewer owns the clashing booking but the clashing guest is another
    // member — "you" would be wrong.
    const message = buildBookingMemberNightConflictMessage([
      conflict({ isOwnBooking: true, canOpenBooking: true }),
    ]);

    expect(message).toContain("Alice Smith is already on a booking");
    expect(message).toContain("Open that booking and change it");
  });

  it("lists every person and the union of their nights when several clash", () => {
    const message = buildBookingMemberNightConflictMessage([
      conflict({ conflictingNights: ["2026-06-02"] }),
      conflict({ memberName: "Cara Lee", conflictingNights: ["2026-06-01"] }),
    ]);

    expect(message).toContain("Alice Smith and Cara Lee are already");
    expect(message).toContain("1 Jun 2026 and 2 Jun 2026");
    expect(message).toContain("Nobody can be on two bookings for the same night");
  });

  it("agrees the verb with the de-duplicated name count, not the row count", () => {
    // One member on two DIFFERENT clashing bookings is two conflict rows and
    // one name. The person-night guard forbids the same night twice, not two
    // bookings inside one requested window, so this is reachable.
    const message = buildBookingMemberNightConflictMessage([
      conflict({ conflictingNights: ["2026-06-01"] }),
      conflict({ conflictingNights: ["2026-06-05"] }),
    ]);

    expect(message).toContain(
      "Alice Smith is already on other bookings for 1 Jun 2026 and 5 Jun 2026.",
    );
    expect(message).not.toContain("Alice Smith are already");
    expect(message).not.toContain("Alice Smith and Alice Smith");
  });

  it("says 'you' rather than the viewer's own name across several clashes", () => {
    const own = buildBookingMemberNightConflictMessage([
      conflict({ conflictingNights: ["2026-06-01"], isSelfGuest: true }),
      conflict({ conflictingNights: ["2026-06-05"], isSelfGuest: true }),
    ]);
    expect(own).toBe(
      "You are already on other bookings for 1 Jun 2026 and 5 Jun 2026. " +
        "Nobody can be on two bookings for the same night, so somebody has to come off one of the bookings.",
    );

    const mixed = buildBookingMemberNightConflictMessage([
      conflict({ conflictingNights: ["2026-06-01"], isSelfGuest: true }),
      conflict({ memberName: "Cara Lee", conflictingNights: ["2026-06-05"] }),
    ]);
    expect(mixed).toContain("You and Cara Lee are already on other bookings");
  });

  it("summarises a long clash rather than listing every night", () => {
    const message = buildBookingMemberNightConflictMessage([
      conflict({
        conflictingNights: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
        ],
      }),
    ]);

    expect(message).toContain(
      "1 Jun 2026, 2 Jun 2026, 3 Jun 2026 and 2 more nights",
    );
  });

  it("never leaks the other booking's owner, id, or stay dates into the summary", () => {
    for (const viewer of [
      conflict(),
      conflict({ canSelfRemove: true, isSelfGuest: true, canOpenBooking: true }),
      conflict({ isOwnBooking: true, canOpenBooking: true }),
    ]) {
      const message = buildBookingMemberNightConflictMessage([viewer]);
      // The summary is composed only from what the requester already supplied:
      // the member they tried to book and the nights they chose.
      expect(message).not.toContain("Bob Jones");
      expect(message).not.toContain("payment pending");
    }
  });

  it("stays useful with an empty conflict list", () => {
    expect(buildBookingMemberNightConflictMessage([])).toContain(
      "already booked",
    );
  });
});

describe("buildBookingMemberNightConflictSummary", () => {
  it("states the situation without the next step, so the wizard banner does not repeat its own card", () => {
    // use-booking-wizard sets the banner from this while the per-conflict card
    // underneath renders describeBookingMemberNightConflictNextStep itself.
    const summary = buildBookingMemberNightConflictSummary([conflict()]);

    expect(summary).toBe(
      "Alice Smith is already on a booking for 1 Jun 2026 and 2 Jun 2026.",
    );
    expect(summary).not.toContain("Ask whoever made that booking");
    expect(summary).not.toContain("choose different dates");
    expect(
      buildBookingMemberNightConflictMessage([conflict()]).startsWith(summary),
    ).toBe(true);
  });
});

describe("describeBookingMemberNightConflictBooking", () => {
  it("withholds the other booking entirely from a viewer who may not open it", () => {
    expect(describeBookingMemberNightConflictBooking(conflict())).toBeNull();
  });

  it("names the owner and status only for an entitled viewer", () => {
    expect(
      describeBookingMemberNightConflictBooking(
        conflict({ canOpenBooking: true }),
      ),
    ).toBe("It is a payment pending booking made by Bob Jones.");
  });

  it("does not tell a member their own booking was made by somebody else", () => {
    expect(
      describeBookingMemberNightConflictBooking(
        conflict({ canOpenBooking: true, isOwnBooking: true }),
      ),
    ).toBe("It is your own payment pending booking.");
  });
});

describe("describeBookingMemberNightConflictNights", () => {
  it("renders date-only nights as club dates, never a browser-local timestamp", () => {
    expect(describeBookingMemberNightConflictNights(conflict())).toBe(
      "Already on a booking for 1 Jun 2026 and 2 Jun 2026.",
    );
    expect(
      describeBookingMemberNightConflictNights(
        conflict({ conflictingNights: ["2026-12-25"], isSelfGuest: true }),
      ),
    ).toBe("Already on another booking for 25 Dec 2026.");
  });

  it("formats nights with the shared kernel helper rather than its own month table", () => {
    /*
      `formatClubDate` follows `APP_LOCALE`, which is configurable, so a
      hardcoded English month list would silently stop matching every other date
      on the page under a different locale.

      THE ORACLE IS THE CALENDAR-DAY FORMATTER, AND THE CHOICE IS THE POINT.
      This case used to build its expectation with
      `formatNZDate(parseDateOnly(night))` — the retired adapter, which pinned
      the key at UTC midnight and then re-read that instant through
      `APP_TIME_ZONE`. That pairing is a PROJECTION: the identity for a club east
      of Greenwich, and the PREVIOUS night for any club west of it. It agreed
      with the subject only because this deployment's zone is New Zealand, so
      the case was passing for the right answer by the wrong route and would have
      pinned the defect as expected behaviour on any other club's deployment.

      `conflictingNights` are `YYYY-MM-DD` lodge nights, which are CALENDAR DAYS
      and have no timezone, so the oracle takes none either — which is exactly
      what `booking-member-night-conflict-messages.ts` itself now does.
    */
    for (const night of ["2026-01-05", "2026-06-01", "2026-12-25"]) {
      expect(
        describeBookingMemberNightConflictNights(
          conflict({ conflictingNights: [night] }),
        ),
      ).toBe(`Already on a booking for ${formatClubDate(requireCalendarDate(night))}.`);
    }
  });

  it("falls back gracefully when no nights were reported", () => {
    expect(
      describeBookingMemberNightConflictNights(
        conflict({ conflictingNights: [] }),
      ),
    ).toContain("the nights you chose");
    expect(
      describeBookingMemberNightConflictNights(
        conflict({ conflictingNights: ["not-a-date"] }),
      ),
    ).toContain("not-a-date");
  });
});

describe("describeBookingMemberNightConflictNextStep", () => {
  it("offers self-removal first, then opening the booking, then asking someone", () => {
    expect(
      describeBookingMemberNightConflictNextStep(
        conflict({ canSelfRemove: true, canOpenBooking: true }),
      ),
    ).toBe("Take yourself off that booking to free those nights.");
    expect(
      describeBookingMemberNightConflictNextStep(
        conflict({ isOwnBooking: true, canOpenBooking: true }),
      ),
    ).toBe("Open that booking and change it.");
    expect(
      describeBookingMemberNightConflictNextStep(
        conflict({ canOpenBooking: true }),
      ),
    ).toBe("Open that booking to sort it out.");
    expect(describeBookingMemberNightConflictNextStep(conflict())).toBe(
      "Ask whoever made that booking, or the club, to take them off it.",
    );
  });

  it("adds the date alternative only for a reader who is choosing the dates", () => {
    const dates = { canChooseDifferentDates: true } as const;

    expect(
      describeBookingMemberNightConflictNextStep(
        conflict({ canSelfRemove: true, canOpenBooking: true }),
        dates,
      ),
    ).toBe(
      "Take yourself off that booking to free those nights, or choose different dates.",
    );
    expect(
      describeBookingMemberNightConflictNextStep(conflict(), dates),
    ).toBe(
      "Ask whoever made that booking, or the club, to take them off it — or choose different dates.",
    );
  });
});
