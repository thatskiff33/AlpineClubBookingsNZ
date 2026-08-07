import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";
import { parseDateOnly } from "@/lib/date-only";
import {
  computeRosterDayStatuses,
  countRosterDaysNeedingChores,
  getRosterMonthStatus,
  type RosterStatusAssignment,
  type RosterStatusBooking,
  type RosterStatusGuest,
} from "@/lib/roster-status";

// roster-status imports prisma at module scope for getRosterMonthStatus. Mock
// it so no real client is constructed. The hoisted findMany refs let the
// getRosterMonthStatus scoping tests below assert on the `where` clauses; the
// pure computeRosterDayStatuses tests never touch them.
const prismaMocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  choreAssignmentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: prismaMocks.bookingFindMany },
    choreAssignment: { findMany: prismaMocks.choreAssignmentFindMany },
  },
}));

function guest(
  stayStart: string,
  stayEnd: string,
  ageTier?: string,
): RosterStatusGuest {
  return {
    stayStart: parseDateOnly(stayStart),
    stayEnd: parseDateOnly(stayEnd),
    ...(ageTier ? { ageTier } : {}),
  };
}

function booking(
  id: string,
  checkIn: string,
  checkOut: string,
  guests: RosterStatusGuest[],
): RosterStatusBooking {
  return {
    id,
    checkIn: parseDateOnly(checkIn),
    checkOut: parseDateOnly(checkOut),
    guests,
  };
}

function assignment(
  date: string,
  status: RosterStatusAssignment["status"],
  bookingId: string,
): RosterStatusAssignment {
  return { date: parseDateOnly(date), status, bookingId };
}

// A single booking staying nights 07-10 and 07-11 (checkout 07-12, half-open).
const B1 = booking("b1", "2099-07-10", "2099-07-12", [guest("2099-07-10", "2099-07-12", "ADULT")]);

describe("computeRosterDayStatuses", () => {
  it("marks a date with no staying booking as no-guests", () => {
    const [result] = computeRosterDayStatuses(["2099-07-20"], [B1], []);
    expect(result).toEqual({
      date: "2099-07-20",
      status: "no-guests",
      stayingBookingCount: 0,
      uncoveredBookingCount: 0,
    });
  });

  // ---------------------------------------------------------------------
  // THE DELIBERATE INVERSION (#2631)
  //
  // This assertion used to read "treats the checkout day (half-open stay) as
  // no-guests", and it was the most direct statement of the rule that produced
  // the complaint: a lodge full of people eating breakfast, stripping beds and
  // shutting down the kitchen, and a roster calendar painting the day grey
  // because nobody sleeps there tonight. It is not weakened here — it is
  // reversed, and states the new rule just as flatly. Everyone in the lodge is
  // there from midday on the day they arrive to midday on the day they leave,
  // so a checkout morning is a day at the lodge and it needs a roster.
  // ---------------------------------------------------------------------
  it("treats the checkout day (half-open stay) as a day at the lodge that needs a roster", () => {
    const [result] = computeRosterDayStatuses(["2099-07-12"], [B1], []);
    expect(result).toEqual({
      date: "2099-07-12",
      status: "needs-roster",
      stayingBookingCount: 1,
      uncoveredBookingCount: 0,
    });
  });

  it("a day whose ONLY occupants leave that morning still needs a roster", () => {
    // Nobody arrives, nobody stays over: the changeover morning on its own.
    const departingOnly = booking("dep", "2099-07-10", "2099-07-11", [
      guest("2099-07-10", "2099-07-11", "ADULT"),
    ]);
    const [result] = computeRosterDayStatuses(["2099-07-11"], [departingOnly], []);
    expect(result.status).toBe("needs-roster");
    expect(result.stayingBookingCount).toBe(1);
  });

  it("the morning AFTER the checkout day is finally empty", () => {
    // The rule ends somewhere: 07-13 is neither a booked night nor the morning
    // after one, so the lodge really is empty.
    const [result] = computeRosterDayStatuses(["2099-07-13"], [B1], []);
    expect(result.status).toBe("no-guests");
  });

  it("a sparse stay paints nothing on its internal gap day", () => {
    // Nights 07-10 and 07-13 only. Present on 10, 11, 13, 14; the 12th is a gap
    // and the 11th's evening is an absence — the guest went home and came back.
    // Without the explicit night rows the envelope 07-10→07-14 would fill all
    // of it, which is why every caller loads `nights`.
    const sparse: RosterStatusBooking = {
      id: "sparse",
      checkIn: parseDateOnly("2099-07-10"),
      checkOut: parseDateOnly("2099-07-14"),
      guests: [
        {
          stayStart: parseDateOnly("2099-07-10"),
          stayEnd: parseDateOnly("2099-07-14"),
          ageTier: "ADULT",
          nights: [
            { stayDate: parseDateOnly("2099-07-10") },
            { stayDate: parseDateOnly("2099-07-13") },
          ],
        },
      ],
    };
    const statuses = computeRosterDayStatuses(
      ["2099-07-10", "2099-07-11", "2099-07-12", "2099-07-13", "2099-07-14"],
      [sparse],
      [],
    ).map((result) => result.status);
    expect(statuses).toEqual([
      "needs-roster", // arrives, night 10
      "needs-roster", // morning after night 10
      "no-guests", //   the gap: adjacent to no booked night
      "needs-roster", // back for night 13
      "needs-roster", // morning after night 13
    ]);
  });

  it("marks a staying date with zero assignments as needs-roster", () => {
    const [result] = computeRosterDayStatuses(["2099-07-10"], [B1], []);
    expect(result).toEqual({
      date: "2099-07-10",
      status: "needs-roster",
      stayingBookingCount: 1,
      uncoveredBookingCount: 0,
    });
  });

  it("marks a date with any SUGGESTED assignment as suggested", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-10", "SUGGESTED", "b1")],
    );
    expect(result.status).toBe("suggested");
  });

  it("precedence: mixed SUGGESTED + CONFIRMED resolves to suggested", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [
        assignment("2099-07-10", "CONFIRMED", "b1"),
        assignment("2099-07-10", "SUGGESTED", "b1"),
      ],
    );
    expect(result.status).toBe("suggested");
  });

  it("marks a fully-covered confirmed date as confirmed", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-10", "CONFIRMED", "b1")],
    );
    expect(result).toEqual({
      date: "2099-07-10",
      status: "confirmed",
      stayingBookingCount: 1,
      uncoveredBookingCount: 0,
    });
  });

  it("COMPLETED assignments also count as covering (confirmed)", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-10", "COMPLETED", "b1")],
    );
    expect(result.status).toBe("confirmed");
  });

  it("case (a): coverage is by bookingId, so a null-guest assignment row still covers its booking", () => {
    // In production a null-bookingGuestId row still carries a non-null bookingId.
    // roster-status only tracks bookingId, so such a row covers the booking and
    // the date does NOT trip needs-attention.
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-10", "CONFIRMED", "b1")],
    );
    expect(result.status).toBe("confirmed");
    expect(result.uncoveredBookingCount).toBe(0);
  });

  it("case (b): a booking added after confirmation with no rows trips needs-attention", () => {
    const late = booking("b2", "2099-07-10", "2099-07-11", [guest("2099-07-10", "2099-07-11", "ADULT")]);
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1, late],
      [assignment("2099-07-10", "CONFIRMED", "b1")],
    );
    expect(result).toEqual({
      date: "2099-07-10",
      status: "needs-attention",
      stayingBookingCount: 2,
      uncoveredBookingCount: 1,
    });
  });

  it("case (c): a busy night where every staying booking has >=1 row does not trip needs-attention", () => {
    // One booking, three guests, but only a single assignment row for the
    // booking. Coverage is per-booking, so this stays confirmed even though two
    // individual guests have no chore.
    const busy = booking("busy", "2099-07-10", "2099-07-11", [
      guest("2099-07-10", "2099-07-11", "ADULT"),
      guest("2099-07-10", "2099-07-11", "ADULT"),
      guest("2099-07-10", "2099-07-11", "YOUTH"),
    ]);
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [busy],
      [assignment("2099-07-10", "CONFIRMED", "busy")],
    );
    expect(result.status).toBe("confirmed");
  });

  it("only counts assignments matching the date (ignores other days' rows)", () => {
    const [result] = computeRosterDayStatuses(
      ["2099-07-10"],
      [B1],
      [assignment("2099-07-11", "CONFIRMED", "b1")],
    );
    // No row for 07-10 → needs-roster, even though 07-11 has one.
    expect(result.status).toBe("needs-roster");
  });

  it("computes each date independently across a range", () => {
    const results = computeRosterDayStatuses(
      ["2099-07-10", "2099-07-11", "2099-07-12"],
      [B1],
      [assignment("2099-07-10", "CONFIRMED", "b1")],
    );
    expect(results.map((r) => r.status)).toEqual([
      "confirmed", // covered
      "needs-roster", // staying, no rows
      "needs-roster", // the checkout MORNING: people here, no rows (#2631)
    ]);
  });

  describe("requireAdultOrYouthForAttention", () => {
    const adultCovered = booking("adult", "2099-07-10", "2099-07-11", [
      guest("2099-07-10", "2099-07-11", "ADULT"),
    ]);
    const childOnly = booking("child", "2099-07-10", "2099-07-11", [
      guest("2099-07-10", "2099-07-11", "CHILD"),
    ]);
    const confirmChild = [assignment("2099-07-10", "CONFIRMED", "adult")];

    it("default (false): a child-only uncovered booking trips needs-attention", () => {
      const [result] = computeRosterDayStatuses(
        ["2099-07-10"],
        [adultCovered, childOnly],
        confirmChild,
      );
      expect(result.status).toBe("needs-attention");
      expect(result.uncoveredBookingCount).toBe(1);
    });

    it("knob on: a child-only uncovered booking is excluded → confirmed", () => {
      const [result] = computeRosterDayStatuses(
        ["2099-07-10"],
        [adultCovered, childOnly],
        confirmChild,
        { requireAdultOrYouthForAttention: true },
      );
      expect(result.status).toBe("confirmed");
      // stayingBookingCount still counts every staying booking.
      expect(result.stayingBookingCount).toBe(2);
    });

    it("knob on: an uncovered ADULT booking still trips needs-attention", () => {
      const adultUncovered = booking("adult2", "2099-07-10", "2099-07-11", [
        guest("2099-07-10", "2099-07-11", "ADULT"),
      ]);
      const [result] = computeRosterDayStatuses(
        ["2099-07-10"],
        [adultCovered, adultUncovered],
        confirmChild,
        { requireAdultOrYouthForAttention: true },
      );
      expect(result.status).toBe("needs-attention");
      expect(result.uncoveredBookingCount).toBe(1);
    });
  });
});

describe("getRosterMonthStatus lodge scoping", () => {
  // Assert the DB-touching entry point threads `lodgeId` into both the booking
  // and the chore-assignment queries (#1587 item 3), so the roster calendar
  // overlay aggregates only the selected lodge's data. prisma is mocked; the
  // where clauses are inspected directly.
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.bookingFindMany.mockResolvedValue([]);
    prismaMocks.choreAssignmentFindMany.mockResolvedValue([]);
  });

  function bookingWhere() {
    return prismaMocks.bookingFindMany.mock.calls[0][0].where;
  }
  function assignmentWhere() {
    return prismaMocks.choreAssignmentFindMany.mock.calls[0][0].where;
  }

  it("scopes both queries to a provided lodgeId", async () => {
    // `lodgeNullTolerantScope` is a strict `{ lodgeId }` match now that Booking
    // is NOT NULL on lodgeId (see docs/multi-lodge/lodge-scoping-contract.md);
    // there are no null-lodge rows to tolerate, so a default vs non-default
    // lodge is scoped identically — the spec's "null rows iff default" clause
    // is stale pre-NOT-NULL language.
    await getRosterMonthStatus({ month: "2099-07", lodgeId: "lodge-a" });

    // Bookings scope directly by lodgeId.
    expect(bookingWhere()).toMatchObject({ lodgeId: "lodge-a" });
    // Chore assignments scope through their (required) booking relation.
    expect(assignmentWhere()).toMatchObject({ booking: { lodgeId: "lodge-a" } });
  });

  it("scopes the default lodge the same strict way (no null-tolerant branch)", async () => {
    await getRosterMonthStatus({ month: "2099-07", lodgeId: "lodge-default" });

    expect(bookingWhere()).toMatchObject({ lodgeId: "lodge-default" });
    expect(assignmentWhere()).toMatchObject({
      booking: { lodgeId: "lodge-default" },
    });
  });

  it("stays club-wide (byte-identical) when no lodgeId is given", async () => {
    await getRosterMonthStatus({ month: "2099-07" });

    // No lodge key is added to either query: the omit path must match the
    // pre-multi-lodge club-wide behaviour exactly.
    expect(bookingWhere()).not.toHaveProperty("lodgeId");
    expect(assignmentWhere()).not.toHaveProperty("booking");
  });

  it("passes the parsed month window through unchanged with a lodgeId", async () => {
    await getRosterMonthStatus({ month: "2099-07", lodgeId: "lodge-a" });

    // Adding the lodge scope must not disturb the operational overlap window.
    const where = bookingWhere();
    expect(where.checkIn).toEqual({ lt: parseDateOnly("2099-08-01") });
    expect(where.checkOut).toEqual({ gte: parseDateOnly("2099-07-01") });
    expect(where.deletedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The window and the filters the calendar loads with (#2631)
// ---------------------------------------------------------------------------

describe("roster-status DB windows carry the operational day (#2631)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.bookingFindMany.mockResolvedValue([]);
    prismaMocks.choreAssignmentFindMany.mockResolvedValue([]);
  });

  const CONSENT_OR = [{ consentStatus: null }, { consentStatus: "CONFIRMED" }];

  function bookingArgs() {
    return prismaMocks.bookingFindMany.mock.calls[0][0];
  }

  it.each([
    [
      "getRosterMonthStatus",
      async () => {
        await getRosterMonthStatus({ month: "2099-07" });
      },
      parseDateOnly("2099-07-01"),
    ],
    [
      "countRosterDaysNeedingChores",
      async () => {
        await countRosterDaysNeedingChores({
          from: parseDateOnly("2099-07-01"),
          to: parseDateOnly("2099-07-08"),
        });
      },
      parseDateOnly("2099-07-01"),
    ],
  ])(
    "MUTATION PROBE: %s asks for a checkout-INCLUSIVE window",
    async (_label, run, windowStart) => {
      await run();
      const args = bookingArgs();

      // `gt` here loses exactly one thing: a booking whose last night was the
      // day before the window opens, whose guests are in the lodge on the first
      // displayed date. Reverting either bound fails.
      expect(args.where.checkOut).toEqual({ gte: windowStart });
      expect(args.where.guests.some.stayEnd).toEqual({ gte: windowStart });
    },
  );

  it.each([
    [
      "getRosterMonthStatus",
      async () => {
        await getRosterMonthStatus({ month: "2099-07" });
      },
    ],
    [
      "countRosterDaysNeedingChores",
      async () => {
        await countRosterDaysNeedingChores({
          from: parseDateOnly("2099-07-01"),
          to: parseDateOnly("2099-07-08"),
        });
      },
    ],
  ])(
    "MUTATION PROBE: %s excludes consent-pending guests and loads the night rows",
    async (_label, run) => {
      await run();
      const args = bookingArgs();

      // D-12 (#2307). Both halves of the pair, or a booking whose only
      // overlapping guest is still awaiting consent paints a colour saying a
      // roster is needed and then opens with nobody to roster.
      expect(args.where.guests.some.OR).toEqual(CONSENT_OR);
      expect(args.select.guests.where.OR).toEqual(CONSENT_OR);
      // And the explicit nights, or a sparse stay's gap day paints as presence.
      expect(args.select.guests.select.nights).toEqual({
        select: { stayDate: true },
      });
    },
  );

  it("counts a departure on the FIRST date of the window", async () => {
    // The booking's last night is 30 June; its guests are in the lodge on the
    // morning of 1 July, the first date the calendar paints. Under the old `gt`
    // bound this row never reached the computation at all.
    prismaMocks.bookingFindMany.mockResolvedValue([
      {
        id: "leaving",
        checkIn: parseDateOnly("2099-06-29"),
        checkOut: parseDateOnly("2099-07-01"),
        guests: [
          {
            stayStart: parseDateOnly("2099-06-29"),
            stayEnd: parseDateOnly("2099-07-01"),
            ageTier: "ADULT",
            nights: [
              { stayDate: parseDateOnly("2099-06-29") },
              { stayDate: parseDateOnly("2099-06-30") },
            ],
          },
        ],
      },
    ]);

    const statuses = await getRosterMonthStatus({ month: "2099-07" });
    expect(statuses[0]).toMatchObject({
      date: "2099-07-01",
      status: "needs-roster",
      stayingBookingCount: 1,
    });
    // …and only that date: the 2nd is genuinely empty.
    expect(statuses[1].status).toBe("no-guests");
  });

  it("countRosterDaysNeedingChores counts the changeover morning as a day of work", async () => {
    prismaMocks.bookingFindMany.mockResolvedValue([
      {
        id: "leaving",
        checkIn: parseDateOnly("2099-06-30"),
        checkOut: parseDateOnly("2099-07-01"),
        guests: [
          {
            stayStart: parseDateOnly("2099-06-30"),
            stayEnd: parseDateOnly("2099-07-01"),
            ageTier: "ADULT",
            nights: [{ stayDate: parseDateOnly("2099-06-30") }],
          },
        ],
      },
    ]);

    const count = await countRosterDaysNeedingChores({
      from: parseDateOnly("2099-07-01"),
      to: parseDateOnly("2099-07-08"),
    });
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The roster's OTHER exclusion (#2631)
// ---------------------------------------------------------------------------

describe("roster-status excludes review-blocked bookings, as the roster does", () => {
  const REVIEW_ALLOWED_OR = checkinNotBlockedByPendingReviewFilter().OR;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.choreAssignmentFindMany.mockResolvedValue([]);
  });

  /**
   * Honours the review filter the way Postgres would. The booking is here on
   * 1 and 2 July; it reaches the computation ONLY if the query forgot to
   * exclude it, which is exactly the regression these cases watch for.
   */
  function installBlockedBookingMock() {
    prismaMocks.bookingFindMany.mockImplementation(async (args: unknown) => {
      const { where } = args as { where: { OR?: unknown } };
      if (JSON.stringify(where.OR) === JSON.stringify(REVIEW_ALLOWED_OR)) {
        return [];
      }
      return [
        {
          id: "booking-blocked",
          checkIn: parseDateOnly("2099-07-01"),
          checkOut: parseDateOnly("2099-07-03"),
          guests: [
            {
              stayStart: parseDateOnly("2099-07-01"),
              stayEnd: parseDateOnly("2099-07-03"),
              ageTier: "ADULT",
              nights: [
                { stayDate: parseDateOnly("2099-07-01") },
                { stayDate: parseDateOnly("2099-07-02") },
              ],
            },
          ],
        },
      ];
    });
  }

  it("the calendar paints no colour on a day whose only booking is blocked", async () => {
    installBlockedBookingMock();

    const statuses = await getRosterMonthStatus({ month: "2099-07" });

    // Before the filter this read `needs-roster` on the 1st, 2nd and 3rd —
    // and the roster page then opened with nobody on it, because
    // `roster-eligibility.ts` has always excluded this booking.
    expect(statuses.every((entry) => entry.status === "no-guests")).toBe(true);
  });

  it("the dashboard headline does not count it as work to do", async () => {
    installBlockedBookingMock();

    const count = await countRosterDaysNeedingChores({
      from: parseDateOnly("2099-07-01"),
      to: parseDateOnly("2099-07-08"),
    });
    expect(count).toBe(0);
  });

  it.each([
    [
      "getRosterMonthStatus",
      async () => {
        await getRosterMonthStatus({ month: "2099-07" });
      },
    ],
    [
      "countRosterDaysNeedingChores",
      async () => {
        await countRosterDaysNeedingChores({
          from: parseDateOnly("2099-07-01"),
          to: parseDateOnly("2099-07-08"),
        });
      },
    ],
  ])("MUTATION PROBE: %s carries the review filter", async (_label, run) => {
    prismaMocks.bookingFindMany.mockResolvedValue([]);
    await run();

    const where = prismaMocks.bookingFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(REVIEW_ALLOWED_OR);
  });
});
