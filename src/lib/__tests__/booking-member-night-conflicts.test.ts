import { BookingStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import { describeBookingMemberNightConflictBooking } from "@/lib/booking-member-night-conflict-messages";
import {
  assertNoBookingMemberNightConflicts,
  BOOKING_MEMBER_NIGHT_CONFLICT_PRIVILEGED_FIELDS,
  BookingMemberNightConflictError,
  findBookingMemberNightConflicts,
  getBookingMemberNightConflictResponse,
  MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES,
  type BookingMemberNightConflict,
} from "@/lib/booking-member-night-conflicts";
import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in, rather than read by the guard under the
// locks its nine authoritative callers hold.
//
// Pinned to 20 May 2026 and NOT to the root frozen clock's 1 July, because this
// suite pins its own instant with `vi.setSystemTime` in two hooks below and
// every stay fixture in the file is written relative to THAT day. Threading the
// root instant instead moved a stay from future to past and correctly flipped
// `canSelfRemove`, which is the fixture agreeing with the code rather than a
// behaviour change.
const FIXTURE_CLUB_TODAY = dateOnlyInstantOf(requireCalendarDate("2026-05-20"));

function existingGuest(overrides: Record<string, unknown> = {}) {
  return {
    id: "guest-1",
    memberId: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    stayStart: null,
    stayEnd: null,
    nights: [],
    member: { firstName: "Alice", lastName: "Smith" },
    booking: {
      id: "booking-1",
      memberId: "member-1",
      status: BookingStatus.DRAFT,
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      member: { firstName: "Alice", lastName: "Smith" },
      guests: [
        { id: "guest-1", memberId: "member-1" },
        { id: "guest-2", memberId: "member-2" },
      ],
    },
    ...overrides,
  };
}

function conflictDb(rows: unknown[]) {
  return {
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue(rows),
    },
  };
}

describe("findBookingMemberNightConflicts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks a member from being added twice on the same lodge night", async () => {
    const db = conflictDb([existingGuest()]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    expect(conflicts).toEqual([
      expect.objectContaining({
        memberId: "member-1",
        memberName: "Alice Smith",
        bookingId: "booking-1",
        bookingStatus: BookingStatus.DRAFT,
        conflictingNights: ["2026-06-01", "2026-06-02"],
        isOwnBooking: true,
        canOpenBooking: true,
        canSelfRemove: false,
        // #2250 — the clashing place is the actor's own, even though they may
        // not self-remove from a booking they own. The copy needs this to
        // address them directly instead of narrating them by name.
        isSelfGuest: true,
      }),
    ]);
  });

  it("marks a future booking self-guest conflict as self-removable", async () => {
    const db = conflictDb([
      existingGuest({
        id: "guest-2",
        memberId: "member-2",
        firstName: "Bob",
        lastName: "Jones",
        member: { firstName: "Bob", lastName: "Jones" },
        booking: {
          id: "booking-2",
          memberId: "member-1",
          status: BookingStatus.PAYMENT_PENDING,
          checkIn: parseDateOnly("2026-06-10"),
          checkOut: parseDateOnly("2026-06-13"),
          member: { firstName: "Alice", lastName: "Smith" },
          guests: [
            { id: "guest-1", memberId: "member-1" },
            { id: "guest-2", memberId: "member-2" },
          ],
        },
      }),
    ]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: "member-2",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-11"),
      checkOut: parseDateOnly("2026-06-12"),
      guests: [{ memberId: "member-2" }],
    });

    expect(conflicts[0]).toMatchObject({
      memberId: "member-2",
      memberName: "Bob Jones",
      bookingId: "booking-2",
      bookingOwnerName: "Alice Smith",
      conflictingNights: ["2026-06-11"],
      isOwnBooking: false,
      canOpenBooking: true,
      canSelfRemove: true,
      isSelfGuest: true,
    });
  });

  it("does not mark somebody else's clashing place as the actor's own", async () => {
    const db = conflictDb([existingGuest()]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: "member-9",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    expect(conflicts[0]).toMatchObject({
      memberId: "member-1",
      isOwnBooking: false,
      canOpenBooking: false,
      canSelfRemove: false,
      isSelfGuest: false,
    });
  });

  // #2250 — the 409 PAYLOAD, not just the copy built from it. A member may
  // legitimately have a family-group member who is a guest on a STRANGER's
  // booking; a side-effect-free POST /api/bookings/quote must not hand them
  // that stranger's name, whole stay range, or ids.
  describe("entitlement-scoped payload", () => {
    // The actor books their family member (member-2), who turns out to be a
    // guest on member-9's booking. The actor owns nothing here and is not the
    // clashing guest, so canOpenBooking is false.
    function strangersBooking() {
      return existingGuest({
        id: "guest-77",
        memberId: "member-2",
        firstName: "Bob",
        lastName: "Jones",
        member: { firstName: "Bob", lastName: "Jones" },
        booking: {
          id: "booking-secret",
          memberId: "member-9",
          status: BookingStatus.PAID,
          checkIn: parseDateOnly("2026-05-28"),
          checkOut: parseDateOnly("2026-06-09"),
          member: { firstName: "Carol", lastName: "Nguyen" },
          guests: [
            { id: "guest-77", memberId: "member-2" },
            { id: "guest-78", memberId: "member-9" },
          ],
        },
      });
    }

    async function conflictFor(actorMemberId: string, actorRole = "USER") {
      const db = conflictDb([strangersBooking()]);
      const conflicts = await findBookingMemberNightConflicts(db as any, {
        today: FIXTURE_CLUB_TODAY,
        actorMemberId,
        actorRole,
        checkIn: parseDateOnly("2026-06-01"),
        checkOut: parseDateOnly("2026-06-03"),
        guests: [{ memberId: "member-2" }],
      });
      expect(conflicts).toHaveLength(1);
      return conflicts[0];
    }

    it("sends an unentitled requester nothing about the clashing booking", async () => {
      const conflict = await conflictFor("member-1");

      expect(conflict.canOpenBooking).toBe(false);
      // A whitelist, not a spot-check: re-adding ANY booking field to the row
      // fails here, which is the regression that let this sit.
      expect(Object.keys(conflict).sort()).toEqual([
        "canOpenBooking",
        "canSelfRemove",
        "conflictingNights",
        "isOwnBooking",
        "isSelfGuest",
        "memberId",
        "memberName",
      ]);
      for (const field of BOOKING_MEMBER_NIGHT_CONFLICT_PRIVILEGED_FIELDS) {
        expect(field in conflict).toBe(false);
      }
      // What they keep is only what they already supplied or already know: the
      // member they tried to book, and the intersection with the nights they
      // chose — never the booking's own wider 28 May–9 Jun range.
      expect(conflict.memberName).toBe("Bob Jones");
      expect(conflict.conflictingNights).toEqual(["2026-06-01", "2026-06-02"]);
    });

    it("keeps every trace of the stranger's booking out of the 409 body", async () => {
      const conflict = await conflictFor("member-1");
      const body = JSON.stringify(
        getBookingMemberNightConflictResponse([conflict]),
      );

      for (const secret of [
        "Carol",
        "Nguyen",
        "booking-secret",
        "guest-77",
        "2026-05-28",
        "2026-06-09",
        "PAID",
        "paid",
      ]) {
        expect(body).not.toContain(secret);
      }
    });

    it("still sends the clashing guest themselves the full detail", async () => {
      // member-2 IS the clashing guest, so canOpenBooking — they may open the
      // booking and take their own place off it.
      const conflict = await conflictFor("member-2");

      expect(conflict.canOpenBooking).toBe(true);
      expect(conflict).toMatchObject({
        bookingId: "booking-secret",
        bookingStatus: BookingStatus.PAID,
        bookingOwnerName: "Carol Nguyen",
        bookingCheckIn: "2026-05-28",
        bookingCheckOut: "2026-06-09",
        guestId: "guest-77",
      });
    });

    it("leaves the admin conflict-resolution path with everything it renders", async () => {
      // POST /api/admin/booking-requests/[id]/link-conflicts and the admin
      // approve / hold / send-quote guards all pass actorRole "ADMIN"; the
      // linking panel renders the owner and both stay dates.
      const conflict = await conflictFor("admin-1", "ADMIN");

      expect(conflict.canOpenBooking).toBe(true);
      for (const field of BOOKING_MEMBER_NIGHT_CONFLICT_PRIVILEGED_FIELDS) {
        expect(conflict[field]).toBeDefined();
      }
      expect(conflict.bookingOwnerName).toBe("Carol Nguyen");
      expect(conflict.bookingCheckIn).toBe("2026-05-28");
      expect(conflict.bookingCheckOut).toBe("2026-06-09");
    });

    it("sends the booking's own owner the full detail", async () => {
      // The default fixture's booking belongs to member-1.
      const db = conflictDb([
        existingGuest({
          id: "guest-3",
          memberId: "member-2",
          member: { firstName: "Bob", lastName: "Jones" },
        }),
      ]);
      const conflicts = await findBookingMemberNightConflicts(db as any, {
        today: FIXTURE_CLUB_TODAY,
        actorMemberId: "member-1",
        actorRole: "USER",
        checkIn: parseDateOnly("2026-06-01"),
        checkOut: parseDateOnly("2026-06-03"),
        guests: [{ memberId: "member-2" }],
      });

      expect(conflicts[0]).toMatchObject({
        isOwnBooking: true,
        canOpenBooking: true,
        bookingId: "booking-1",
        bookingOwnerName: "Alice Smith",
        guestId: "guest-3",
      });
    });
  });

  it("honors sparse explicit nights before reporting a conflict", async () => {
    const db = conflictDb([
      existingGuest({
        nights: [{ stayDate: parseDateOnly("2026-06-01") }],
      }),
    ]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [
        {
          memberId: "member-1",
          nights: ["2026-06-02"],
        },
      ],
    });

    expect(conflicts).toEqual([]);
  });

  it("queries only live booking statuses without changing capacity semantics", async () => {
    const db = conflictDb([]);

    await findBookingMemberNightConflicts(db as any, {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    expect(MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES).toContain(BookingStatus.DRAFT);
    expect(MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES).toContain(BookingStatus.PAYMENT_PENDING);
    expect(MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES).not.toContain(BookingStatus.CANCELLED);
    expect(db.bookingGuest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining({
            deletedAt: null,
            status: { in: [...MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES] },
            OR: expect.arrayContaining([
              { status: { not: BookingStatus.DRAFT } },
              { draftExpiresAt: null },
              expect.objectContaining({ draftExpiresAt: expect.any(Object) }),
            ]),
          }),
        }),
      }),
    );
  });

  // #1881 — the authoritative assert takes a per-member advisory lock (sorted,
  // in its own namespace) BEFORE reading, so the cross-lodge person-night
  // invariant is serialised even though capacity locks are per-lodge only.
  it("locks every member-linked guest's per-member key (sorted) before reading, then throws on a conflict", async () => {
    const executeRawCalls: string[] = [];
    const lockValues: unknown[][] = [];
    const db = {
      $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
        executeRawCalls.push(strings.join("|"));
        lockValues.push(values);
        return Promise.resolve(1);
      }),
      bookingGuest: {
        findMany: vi.fn().mockImplementation(async () => {
          // Reads must happen AFTER both per-member locks are taken.
          expect(executeRawCalls).toHaveLength(2);
          return [];
        }),
      },
    };

    await assertNoBookingMemberNightConflicts(db as never, {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: "member-2",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      // Deliberately out of order to prove sorted acquisition.
      guests: [{ memberId: "member-2" }, { memberId: "member-1" }],
    });

    // Two per-member advisory locks were taken before the read.
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    for (const call of executeRawCalls) {
      expect(call).toContain("pg_advisory_xact_lock");
      expect(call).toContain("hashtext");
    }
    // Sorted memberId order: each lock's bind params are [namespace, memberId],
    // and the sorted acquisition puts member-1 before member-2.
    const lockOrder = lockValues.map((values) => values[1]);
    expect(lockOrder).toEqual(["member-1", "member-2"]);
  });
});

// #2250 — the already-booked copy on both paths a member can hit it: the
// advisory pre-check that builds a 409 body from a found conflict list
// (getBookingMemberNightConflictResponse, what the booking wizard renders) and
// the transactional guard that throws (BookingMemberNightConflictError, whose
// message every 409 route surfaces). Both must say who, which nights, and what
// to do next — without telling the requester about a booking they may not see.
describe("booking member-night conflict messages", () => {
  function conflictRow(
    overrides: Partial<BookingMemberNightConflict> = {},
  ): BookingMemberNightConflict {
    return {
      memberId: "member-2",
      memberName: "Bob Jones",
      bookingId: "booking-2",
      bookingStatus: BookingStatus.PAYMENT_PENDING,
      bookingOwnerName: "Carol Nguyen",
      bookingCheckIn: "2026-06-10",
      bookingCheckOut: "2026-06-13",
      guestId: "guest-2",
      conflictingNights: ["2026-06-11", "2026-06-12"],
      isOwnBooking: false,
      canOpenBooking: false,
      canSelfRemove: false,
      isSelfGuest: false,
      ...overrides,
    };
  }

  it("tells the wizard path who, which nights, and what to do next", () => {
    const body = getBookingMemberNightConflictResponse([conflictRow()]);

    expect(body.code).toBe("BOOKING_MEMBER_NIGHT_CONFLICT");
    expect(body.error).toBe(
      "Bob Jones is already on a booking for 11 Jun 2026 and 12 Jun 2026. " +
        "Ask whoever made that booking, or the club, to take them off it.",
    );
  });

  it("keeps the 409 flow-neutral, because admin booking-request routes return it too", () => {
    // approve / hold / send-quote all surface this body; "choose different
    // dates" is advice only the person picking the dates can act on, and the
    // booking wizard opts back into it when it renders the next step itself.
    for (const conflicts of [
      [conflictRow()],
      [conflictRow({ canSelfRemove: true, isSelfGuest: true })],
      [conflictRow(), conflictRow({ memberName: "Dana Patel" })],
    ]) {
      expect(getBookingMemberNightConflictResponse(conflicts).error).not.toContain(
        "choose different dates",
      );
    }
  });

  it("offers self-removal in the message when this viewer may take themselves off", () => {
    const body = getBookingMemberNightConflictResponse([
      conflictRow({ canSelfRemove: true, isSelfGuest: true, canOpenBooking: true }),
    ]);

    expect(body.error).toContain("You are already on another booking");
    expect(body.error).toContain("Take yourself off that booking");
  });

  it("addresses the member directly when they clash with their own earlier booking", () => {
    const body = getBookingMemberNightConflictResponse([
      conflictRow({
        isSelfGuest: true,
        isOwnBooking: true,
        canOpenBooking: true,
        canSelfRemove: false,
      }),
    ]);

    expect(body.error).toBe(
      "You are already on another booking for 11 Jun 2026 and 12 Jun 2026. " +
        "Open that booking and change it.",
    );
    expect(body.error).not.toContain("Bob Jones");
  });

  it("carries the same message on the transactional 409 path", () => {
    const error = new BookingMemberNightConflictError([conflictRow()]);

    expect(error.message).toBe(
      getBookingMemberNightConflictResponse([conflictRow()]).error,
    );
    expect(error.name).toBe("BookingMemberNightConflictError");
    expect(error.conflicts).toHaveLength(1);
  });

  it("never names the other booking's owner in a message a stranger receives", () => {
    // Belt and braces: `findBookingMemberNightConflicts` no longer puts these
    // fields on an unentitled row at all (see "entitlement-scoped payload"),
    // but the copy layer gates independently — hand it a row that DOES carry
    // them with canOpenBooking false and the message must still not restate
    // them.
    const body = getBookingMemberNightConflictResponse([conflictRow()]);

    expect(body.error).not.toContain("Carol Nguyen");
    expect(body.error).not.toContain("booking-2");
    expect(body.error).not.toContain("payment pending");
  });

  it("says nothing about the booking when an entitled row arrives without it", () => {
    // Fail closed rather than rendering "It is a undefined booking." if a
    // future producer ever marks a row canOpenBooking without the detail.
    const scoped: BookingMemberNightConflict = {
      memberId: "member-2",
      memberName: "Bob Jones",
      conflictingNights: ["2026-06-11"],
      isOwnBooking: false,
      canOpenBooking: true,
      canSelfRemove: false,
      isSelfGuest: false,
    };

    expect(describeBookingMemberNightConflictBooking(scoped)).toBeNull();
    expect(
      describeBookingMemberNightConflictBooking({
        ...scoped,
        bookingStatus: BookingStatus.PAID,
      }),
    ).toBeNull();
    expect(
      describeBookingMemberNightConflictBooking({
        ...scoped,
        bookingStatus: BookingStatus.PAID,
        bookingOwnerName: "Carol Nguyen",
      }),
    ).toBe("It is a paid booking made by Carol Nguyen.");
  });

  it("names everyone and the union of the clashing nights when several members clash", () => {
    const body = getBookingMemberNightConflictResponse([
      conflictRow({ conflictingNights: ["2026-06-12"] }),
      conflictRow({
        memberId: "member-3",
        memberName: "Dana Patel",
        conflictingNights: ["2026-06-11"],
      }),
    ]);

    expect(body.error).toBe(
      "Bob Jones and Dana Patel are already on other bookings for 11 Jun 2026 and 12 Jun 2026. " +
        "Nobody can be on two bookings for the same night, so somebody has to come off one of the bookings.",
    );
  });

  it("agrees the verb with the number of PEOPLE, not the number of conflict rows", () => {
    // One member on two different clashing bookings inside the requested window
    // is two rows and one name — "Bob Jones are already" was reachable.
    const body = getBookingMemberNightConflictResponse([
      conflictRow({ bookingId: "booking-2", conflictingNights: ["2026-06-11"] }),
      conflictRow({ bookingId: "booking-3", conflictingNights: ["2026-06-12"] }),
    ]);

    expect(body.error).toContain(
      "Bob Jones is already on other bookings for 11 Jun 2026 and 12 Jun 2026.",
    );
    expect(body.error).not.toContain("Bob Jones are already");
  });
});

// ============================================================================
// FREEZE TEST (#2307): a PENDING member guest still holds their person-night
// ============================================================================
//
// Owner decision D-12 keeps an unconsented member guest off every operational
// surface. This is NOT one of them, and the reason is sharper than "capacity
// holds a bed" (D-4), though that is also true.
//
// A person-night conflict exists to stop ONE MEMBER being placed in TWO BEDS on
// ONE NIGHT. A PENDING guest row is holding a bed for that member on that night.
// Filter it out here and the same member can be added to a second booking for
// the same night — and if the pending consent is then confirmed, the club has
// two beds committed to one person and no code path that notices.
//
// The consent state is deliberately never read on this path. This freezes that.
describe("#2307 person-night conflicts still see a PENDING member guest (D-4/D-12)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a conflict against a guest row whose consent is still PENDING", async () => {
    const db = conflictDb([
      existingGuest({
        consentStatus: "PENDING",
        consentRequestedAt: new Date("2026-05-18T00:00:00.000Z"),
        consentExpiresAt: new Date("2026-05-31T12:00:00.000Z"),
      }),
    ]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      memberId: "member-1",
      bookingId: "booking-1",
      conflictingNights: ["2026-06-01", "2026-06-02"],
    });
  });

  it("reports a conflict against a DECLINED or EXPIRED row that survived removal", async () => {
    // A row whose removal was refused (it goes to the admin exception list) is
    // still occupying the night until an admin resolves it, so it still clashes.
    for (const consentStatus of ["DECLINED", "EXPIRED"]) {
      const db = conflictDb([existingGuest({ consentStatus })]);

      const conflicts = await findBookingMemberNightConflicts(db as any, {
        today: FIXTURE_CLUB_TODAY,
        actorMemberId: "member-1",
        actorRole: "USER",
        checkIn: parseDateOnly("2026-06-01"),
        checkOut: parseDateOnly("2026-06-03"),
        guests: [{ memberId: "member-1" }],
      });

      expect(conflicts, `a ${consentStatus} row must still clash`).toHaveLength(1);
    }
  });

  it("sends no consent filter in the conflict lookup", async () => {
    const db = conflictDb([]);

    await findBookingMemberNightConflicts(db as any, {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    const args = db.bookingGuest.findMany.mock.calls[0][0];
    expect(JSON.stringify(args.where)).not.toContain("consentStatus");
  });
});
