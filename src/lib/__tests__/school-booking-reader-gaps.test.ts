/**
 * THE THREE WAYS A SCHOOL BOOKING STILL DISAPPEARED (#3369, `INV-SSOT-005`).
 *
 * Stage 4 makes a booking's member link optional, and the ownership sweep
 * routed every READ through `bookingOwner()`. The census in
 * `booking-owner-census.test.ts` keeps that true. What neither the sweep nor
 * that census could see are the two shapes with no property read in them:
 *
 * 1. **A `where` that filters through the member relation.** On a nullable
 *    to-one, `member: { is: … }` excludes every organisation-owned row — from
 *    the page, from the pagination window, and from the total count. No read,
 *    no type error, and an officer typing a school's name into the admin
 *    bookings search box got zero results for bookings that display perfectly
 *    with the filter cleared.
 * 2. **A `select` that loads `member` without `organisation`.** The accessor
 *    can only build the owner projection when both were loaded, so it hands the
 *    null member straight back. Three queries shipped it: the two capacity
 *    conflict lists an officer sees when overriding a hold, and the chore
 *    roster's group label.
 *
 * These are the regression tests for both. They assert against the real filter
 * builder and the real conflict query, not against a copy of their shapes.
 */
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "@prisma/client";

import {
  adminBookingsClubDay,
  adminBookingsQuerySchema,
  buildAdminBookingsWhere,
} from "@/lib/admin-bookings-service";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import {
  findOverlappingCapacityHoldingBookings,
  findOverlappingOverriddenNonHoldingBookings,
} from "@/lib/capacity";
import { getOperationalRosterGuestsForDate } from "@/lib/roster-eligibility";

const clubDay = adminBookingsClubDay(
  bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST),
);

/** Does `where` accept a row whose member is absent and whose owner is a school? */
function matchesSchoolOwnedRow(where: Prisma.BookingWhereInput): boolean {
  // A structural read rather than a database: the defect is that the school
  // arm is ABSENT, so what must be proved is that the search clause names the
  // organisation relation at all, and that it does not sit on `where.member`
  // where a null-owner row can never reach it.
  const serialised = JSON.stringify(where);
  return serialised.includes('"organisation"');
}

describe("#3369: the admin bookings list search finds a school's bookings", () => {
  const search = (q: string) =>
    buildAdminBookingsWhere(
      adminBookingsQuerySchema.parse({ search: q }),
      clubDay,
    );

  it("does not hang the search off `member`, which excludes every null-owner row", () => {
    // The defect, exactly. `where.member = { is: … }` on a nullable to-one is a
    // relation filter: a booking with no member cannot satisfy it, so every
    // school booking left the page, the window and the count together.
    const where = search("Tokoroa");
    expect(
      where.member,
      "The search clause is back on `where.member`. On a nullable to-one that " +
        "excludes every organisation-owned booking from the page, the " +
        "pagination window AND the total count (#3369).",
    ).toBeUndefined();
  });

  it("searches the organisation as well as the member", () => {
    expect(matchesSchoolOwnedRow(search("Tokoroa"))).toBe(true);
  });

  it("matches a school on its name or its email, like a member's three fields", () => {
    const serialised = JSON.stringify(search("Tokoroa"));
    // The organisation arm carries both of the two fields a school presents
    // itself by. A name-only arm would find the school but not an officer
    // searching by the address the club invoices.
    const organisationArm = serialised.slice(serialised.indexOf('"organisation"'));
    expect(organisationArm).toContain('"name"');
    expect(organisationArm).toContain('"email"');
  });

  it("still requires EVERY term to match ONE party", () => {
    // Two terms must not be satisfied by one matching the member and the other
    // matching the organisation — that would widen the search rather than fix
    // it. Each arm carries its own AND over the terms.
    const serialised = JSON.stringify(search("Tokoroa Primary"));
    const arms = serialised.split('"AND"').length - 1;
    expect(arms).toBeGreaterThanOrEqual(2);
  });

  it("adds nothing when there is no search term", () => {
    const where = buildAdminBookingsWhere(
      adminBookingsQuerySchema.parse({}),
      clubDay,
    );
    expect(JSON.stringify(where)).not.toContain('"organisation"');
  });
});

describe("#3369: a hold conflict names the school rather than 'Unknown member'", () => {
  const SCHOOL_ROW = {
    id: "b-school",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    status: "CONFIRMED" as const,
    memberId: null,
    member: null,
    organisationId: "org-tps",
    organisation: { name: "Tokoroa Primary School", email: "office@tps.test" },
    _count: { guests: 12 },
  };

  const input = {
    lodgeId: "lodge-1",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
  };

  it("loads the organisation, so the accessor has a projection to build", async () => {
    // The select is what was wrong: both conflict queries asked for `member`
    // alone, so `bookingOwner(row).member` was the null member itself and the
    // officer overriding a hold was shown "Unknown member" for the booking they
    // were about to override.
    const findMany = vi.fn().mockResolvedValue([SCHOOL_ROW]);
    const rows = await findOverlappingCapacityHoldingBookings(
      { booking: { findMany } } as never,
      input,
    );
    const select = findMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
    expect(
      select.organisation,
      "The capacity-holding conflict query must load the organisation; " +
        "without it the accessor hands the null member back (#3369).",
    ).toBeDefined();
    expect(rows[0]?.memberName).toBe("Tokoroa Primary School");
  });

  it("does the same on the overridden non-holding companion", async () => {
    const findMany = vi.fn().mockResolvedValue([SCHOOL_ROW]);
    const rows = await findOverlappingOverriddenNonHoldingBookings(
      { booking: { findMany } } as never,
      input,
    );
    const select = findMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
    expect(select.organisation).toBeDefined();
    expect(rows[0]?.memberName).toBe("Tokoroa Primary School");
    expect(rows[0]?.overridden).toBe(true);
  });

  it("still names a member-owned booking the way it always did", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        ...SCHOOL_ROW,
        id: "b-member",
        memberId: "m-1",
        member: { firstName: "Ada", lastName: "Ordinary", email: "ada@example.test" },
        organisationId: null,
        organisation: null,
      },
    ]);
    const rows = await findOverlappingCapacityHoldingBookings(
      { booking: { findMany } } as never,
      input,
    );
    expect(rows[0]?.memberName).toBe("Ada Ordinary");
  });
});

describe("#3369: the chore roster names the school rather than 'Booking group N'", () => {
  const day = new Date("2026-08-01T00:00:00.000Z");

  /** One present guest, minimal but real: the roster re-tests every night row. */
  const GUEST = {
    id: "g-1",
    firstName: "Sam",
    lastName: "Tui",
    ageTier: "ADULT" as const,
    isMember: false,
    memberId: null,
    member: null,
    consentStatus: null,
    stayStart: new Date("2026-08-01T00:00:00.000Z"),
    stayEnd: new Date("2026-08-03T00:00:00.000Z"),
    nights: [
      { stayDate: new Date("2026-08-01T00:00:00.000Z") },
      { stayDate: new Date("2026-08-02T00:00:00.000Z") },
    ],
  };

  const BOOKING = {
    id: "b-1",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    guests: [GUEST],
  };

  const rosterFor = async (owner: Record<string, unknown>) => {
    const findMany = vi.fn().mockResolvedValue([{ ...BOOKING, ...owner }]);
    const rows = await getOperationalRosterGuestsForDate(day, "lodge-1", {
      booking: { findMany },
    } as never);
    return { rows, include: findMany.mock.calls[0]?.[0]?.include as Record<string, unknown> };
  };

  it("loads the organisation beside the member", async () => {
    // The defect: `include: { member: … }` with no `organisation`, so the
    // accessor had no projection to build and handed the null member back. The
    // label then fell through to its positional fallback and a school's chore
    // group lost its name on a printed sheet.
    const { include } = await rosterFor({
      memberId: "m-1",
      member: { firstName: "Ada", lastName: "Ordinary" },
      organisation: null,
    });
    expect(
      include.organisation,
      "The roster query must load the organisation; without it a school's " +
        "chore group degrades to `Booking group N` (#3369).",
    ).toBeDefined();
  });

  it("labels a school's group with the school's name", async () => {
    const { rows } = await rosterFor({
      memberId: null,
      member: null,
      organisationId: "org-tps",
      organisation: { name: "Tokoroa Primary School", email: "office@tps.test" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bookingGroupLabel).toBe("Booking for Tokoroa Primary School");
  });

  it("still labels a member's group the way it always did", async () => {
    const { rows } = await rosterFor({
      memberId: "m-1",
      member: { firstName: "Ada", lastName: "Ordinary" },
      organisation: null,
    });
    expect(rows[0]?.bookingGroupLabel).toBe("Booking for Ada Ordinary");
  });
});
