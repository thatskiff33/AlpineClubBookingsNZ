import { describe, expect, it } from "vitest";
import {
  findHutLeaderStayRefusal,
  HUT_LEADER_NIGHTS_NOT_STAYED,
  isHutLeaderStayCheckExempt,
  loadHutLeaderStayedNightKeys,
  stayedNightRunContaining,
} from "@/lib/hut-leader-stayed-nights";

/**
 * The stay check behind the manual hut-leader create and edit (#3817, owner
 * decision "Block it outright"): a role-only assignment may claim only nights
 * the member is staying at that lodge.
 *
 * The double below is a small in-memory database that applies the filters the
 * check sends — lodge, status, the overlap bounds, consent and member — so a
 * cancelled stay or another lodge's stay is excluded by the QUERY, the same way
 * Postgres would exclude it, rather than by the fixture leaving it out.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Booking = {
  id: string;
  lodgeId: string;
  status: string;
  memberId: string | null;
  deletedAt?: Date | null;
  checkIn: Date;
  checkOut: Date;
  guests: Array<{
    memberId: string | null;
    consentStatus: string | null;
    stayStart: Date;
    stayEnd: Date;
    nights: Array<{ stayDate: Date }>;
  }>;
};

type BookingWhere = {
  deletedAt?: null;
  lodgeId: string;
  status: { in: string[] };
  checkIn: { lte: Date };
  checkOut: { gt: Date };
  memberId?: string;
};

function bookingMatches(booking: Booking, where: BookingWhere) {
  return (
    (where.deletedAt === undefined || (booking.deletedAt ?? null) === null) &&
    booking.lodgeId === where.lodgeId &&
    where.status.in.includes(booking.status) &&
    booking.checkIn <= where.checkIn.lte &&
    booking.checkOut > where.checkOut.gt &&
    (where.memberId === undefined || booking.memberId === where.memberId)
  );
}

function fakeDb(bookings: Booking[]) {
  return {
    bookingGuest: {
      findMany: async (args: {
        where: {
          memberId: string;
          OR: Array<{ consentStatus: string | null }>;
          booking: BookingWhere;
        };
      }) =>
        bookings
          .filter((booking) => bookingMatches(booking, args.where.booking))
          .flatMap((booking) =>
            booking.guests
              .filter(
                (guest) =>
                  guest.memberId === args.where.memberId &&
                  args.where.OR.some((o) => o.consentStatus === guest.consentStatus),
              )
              .map((guest) => ({
                stayStart: guest.stayStart,
                stayEnd: guest.stayEnd,
                nights: guest.nights,
                booking: { checkIn: booking.checkIn, checkOut: booking.checkOut },
              })),
          ),
    },
    booking: {
      findMany: async (args: {
        where: BookingWhere;
        select: { guests: { where: { memberId: string } } };
      }) =>
        bookings
          .filter((booking) => bookingMatches(booking, args.where))
          .map((booking) => ({
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            guests: booking.guests.filter(
              (guest) => guest.memberId === args.select.guests.where.memberId,
            ),
          })),
    },
  } as never;
}

/** A PAID booking at lodge-a with the member as its only guest. */
function stay(
  checkIn: string,
  checkOut: string,
  overrides: Partial<Booking> & { nights?: string[]; consentStatus?: string | null } = {},
): Booking {
  const { nights, consentStatus, ...rest } = overrides;
  return {
    id: `${checkIn}-${checkOut}`,
    lodgeId: "lodge-a",
    status: "PAID",
    memberId: "owner-x",
    checkIn: day(checkIn),
    checkOut: day(checkOut),
    guests: [
      {
        memberId: "member-1",
        consentStatus: consentStatus ?? null,
        stayStart: day(checkIn),
        stayEnd: day(checkOut),
        nights: (nights ?? []).map((n) => ({ stayDate: day(n) })),
      },
    ],
    ...rest,
  };
}

const ask = (db: never, startDate: string, endDate: string) =>
  findHutLeaderStayRefusal(db, {
    memberId: "member-1",
    lodgeId: "lodge-a",
    startDate: day(startDate),
    endDate: day(endDate),
  });

describe("findHutLeaderStayRefusal (#3817)", () => {
  // Arrive Mon 6 Jul, leave Wed 8 Jul: nights 6 and 7.
  const monToWed = stay("2026-07-06", "2026-07-08");

  it("accepts an assignment over exactly the nights stayed", async () => {
    expect(await ask(fakeDb([monToWed]), "2026-07-06", "2026-07-07")).toBeNull();
  });

  it("refuses the CHECK-OUT night, naming it and the last night stayed", async () => {
    const refusal = await ask(fakeDb([monToWed]), "2026-07-06", "2026-07-08");
    expect(refusal).toEqual(
      expect.objectContaining({
        code: HUT_LEADER_NIGHTS_NOT_STAYED,
        firstNightNotStayed: "2026-07-08",
        lastNightStayed: "2026-07-07",
      }),
    );
    expect(refusal?.error).toContain("2026-07-08");
    expect(refusal?.error).toContain("2026-07-07");
  });

  it("refuses a CANCELLED stay — a cancelled stay is not a stay", async () => {
    const cancelled = stay("2026-07-06", "2026-07-08", { status: "CANCELLED" });
    const refusal = await ask(fakeDb([cancelled]), "2026-07-06", "2026-07-07");
    expect(refusal).toEqual(
      expect.objectContaining({ firstNightNotStayed: "2026-07-06", lastNightStayed: null }),
    );
  });

  it("counts a COMPLETED stay (a past assignment edited after the stay)", async () => {
    const completed = stay("2026-07-06", "2026-07-08", { status: "COMPLETED" });
    expect(await ask(fakeDb([completed]), "2026-07-06", "2026-07-07")).toBeNull();
  });

  it("refuses a SOFT-DELETED stay, whatever its status", async () => {
    const deleted = stay("2026-07-06", "2026-07-08", { deletedAt: day("2026-07-01") });
    expect(await ask(fakeDb([deleted]), "2026-07-06", "2026-07-07")).not.toBeNull();
  });

  it("refuses a stay at ANOTHER lodge", async () => {
    const elsewhere = stay("2026-07-06", "2026-07-08", { lodgeId: "lodge-b" });
    expect(await ask(fakeDb([elsewhere]), "2026-07-06", "2026-07-07")).not.toBeNull();
  });

  it("refuses a guest row whose consent is still pending (D-12)", async () => {
    const pending = stay("2026-07-06", "2026-07-08", { consentStatus: "PENDING" });
    expect(await ask(fakeDb([pending]), "2026-07-06", "2026-07-07")).not.toBeNull();
  });

  it("refuses a split stay's GAP night and offers the end of the first run", async () => {
    // Nights 6, 7 and 9: the envelope 6-10 fills the 8th, the night set does not.
    const split = stay("2026-07-06", "2026-07-10", {
      nights: ["2026-07-06", "2026-07-07", "2026-07-09"],
    });
    const refusal = await ask(fakeDb([split]), "2026-07-06", "2026-07-09");
    expect(refusal).toEqual(
      expect.objectContaining({ firstNightNotStayed: "2026-07-08", lastNightStayed: "2026-07-07" }),
    );
  });

  it("counts the member as a booking OWNER with no guest row (the booking's nights)", async () => {
    const owned: Booking = { ...stay("2026-07-06", "2026-07-08"), memberId: "member-1", guests: [] };
    expect(await ask(fakeDb([owned]), "2026-07-06", "2026-07-07")).toBeNull();
  });

  it("joins two back-to-back stays into one run", async () => {
    const first = stay("2026-07-06", "2026-07-08");
    const second = stay("2026-07-08", "2026-07-10");
    expect(await ask(fakeDb([first, second]), "2026-07-06", "2026-07-09")).toBeNull();
  });

  it("Wednesday-leave / Thursday-arrive: neither leader may claim Wednesday night", async () => {
    // Leader A leaves Wed 8 Jul (last night Tue 7th); leader B arrives Thu 9th.
    const leaverRefusal = await ask(fakeDb([monToWed]), "2026-07-06", "2026-07-08");
    expect(leaverRefusal?.firstNightNotStayed).toBe("2026-07-08");
    const arriver = stay("2026-07-09", "2026-07-11");
    const arriverRefusal = await ask(fakeDb([arriver]), "2026-07-08", "2026-07-10");
    expect(arriverRefusal?.firstNightNotStayed).toBe("2026-07-08");
    // The arriver's start night is not stayed, so no corrected end is offered.
    expect(arriverRefusal?.lastNightStayed).toBeNull();
  });
});

describe("loadHutLeaderStayedNightKeys", () => {
  it("clips to the asked range and never returns a check-out morning", async () => {
    const keys = await loadHutLeaderStayedNightKeys(fakeDb([stay("2026-07-06", "2026-07-10")]), {
      memberId: "member-1",
      lodgeId: "lodge-a",
      rangeStart: day("2026-07-07"),
      rangeEnd: day("2026-07-12"),
    });
    expect(keys).toEqual(["2026-07-07", "2026-07-08", "2026-07-09"]);
  });
});

describe("stayedNightRunContaining", () => {
  it("returns the consecutive run around a night, or null for an unstayed one", () => {
    const nights = ["2026-07-06", "2026-07-07", "2026-07-09", "2026-07-10"];
    expect(stayedNightRunContaining(nights, "2026-07-07")).toEqual({
      first: "2026-07-06",
      last: "2026-07-07",
    });
    expect(stayedNightRunContaining(nights, "2026-07-10")).toEqual({
      first: "2026-07-09",
      last: "2026-07-10",
    });
    expect(stayedNightRunContaining(nights, "2026-07-08")).toBeNull();
  });
});

describe("isHutLeaderStayCheckExempt (#3817)", () => {
  it("exempts a held bed or the custodian tick, and nothing else", () => {
    expect(isHutLeaderStayCheckExempt({ bedId: "bed-1", isCustodian: false })).toBe(true);
    expect(isHutLeaderStayCheckExempt({ bedId: null, isCustodian: true })).toBe(true);
    expect(isHutLeaderStayCheckExempt({ bedId: "bed-1", isCustodian: true })).toBe(true);
    expect(isHutLeaderStayCheckExempt({ bedId: null, isCustodian: false })).toBe(false);
  });
});
