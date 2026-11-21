/**
 * The paid-booking import planner's own decisions (#5005 child A, `INV-CAP-040`),
 * run through the real `planBookingImport` and `checkImportBooking`.
 *
 * The database is doubled at the Prisma boundary (lodge, member, season and
 * import-row reads). The four collaborators that read bookings through their
 * own SQL are doubled with small models of their answers: the capacity engine
 * (beds held per night, whole-lodge holds, the proposed guests added on top),
 * the person-night scan, the hosting rule and the rate engine. What is under
 * test is the planner's arithmetic and wording around them: outcomes and
 * reasons per booking, beds claimed in file order, the same member twice in
 * the file, totals by outcome and by first reason, the night table, the
 * resumed-batch view and the digest. `booking-import.realdb.test.ts` runs the
 * same planner against real PostgreSQL.
 */
import { AgeTier, BookingImportRowStatus, type Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  capacity: 4,
  held: new Map<string, number>(),
  wholeLodge: new Set<string>(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/capacity", () => {
  type Guest = { stayStart: Date; stayEnd: Date };
  const nightKey = (date: Date) => date.toISOString().slice(0, 10);
  return {
    getLodgeCapacity: vi.fn(async () => state.capacity),
    // A model of the engine's answer: beds held in the app that night, plus each
    // proposed guest staying it; a whole-lodge night is pinned to 0 available.
    checkCapacityForGuestRanges: vi.fn(async (_lodgeId: string, checkIn: Date, checkOut: Date, guests: Guest[]) => {
      const nightDetails = [];
      for (let date = checkIn; date < checkOut; date = new Date(date.getTime() + 86_400_000)) {
        const key = nightKey(date);
        const occupiedBeds = (state.held.get(key) ?? 0) + guests.filter((guest) => guest.stayStart <= date && date < guest.stayEnd).length;
        const wholeLodgeHeld = state.wholeLodge.has(key);
        nightDetails.push({ date, occupiedBeds, availableBeds: wholeLodgeHeld ? 0 : state.capacity - occupiedBeds, wholeLodgeHeld });
      }
      const minAvailable = Math.min(...nightDetails.map((night) => night.availableBeds));
      return { available: minAvailable >= 0 && !nightDetails.some((night) => night.wholeLodgeHeld), minAvailable, nightDetails };
    }),
  };
});

vi.mock("@/lib/booking-member-night-conflicts", () => ({
  lockBookingMemberNights: vi.fn(async () => undefined),
  findBookingMemberNightConflicts: vi.fn(async () => []),
}));

vi.mock("@/lib/adult-member-hosting-proposed", () => ({
  evaluateProposedAdultMemberHosting: vi.fn(async () => null),
}));

vi.mock("@/lib/membership-type-policy", () => ({
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(async (_db: unknown, input: { guests: unknown[] }) => ({
    totalPriceCents: input.guests.length * 4_000,
  })),
}));

import { evaluateProposedAdultMemberHosting } from "@/lib/adult-member-hosting-proposed";
import { findBookingMemberNightConflicts, lockBookingMemberNights } from "@/lib/booking-member-night-conflicts";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { formatStayDate } from "@/lib/club-time";
import { parseDateOnly } from "@/lib/date-only";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import { parseBookingImportCsv, type ParsedImportBooking } from "@/lib/booking-import/parse";
import {
  BOOKING_IMPORT_HOSTING_REFUSAL,
  bookingImportBatchKey,
  bookingImportPlanDigest,
  checkImportBooking,
  emptyBookingImportFileState,
  planBookingImport,
  type BookingImportContext,
  type ResolvedImportBooking,
} from "@/lib/booking-import/plan";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const FORMAT = { locale: CLUB_FORMAT_TEST.locale };
const TODAY = new Date("2026-07-01T00:00:00.000Z");
const LODGE = { id: "lodge-1", name: "Ridge Lodge", slug: "ridge", active: true };

const HEADER =
  "Booking Ref,Owner Email,Owner First Name,Owner Last Name,Guest Type,Guest Email,Guest First Name,Guest Last Name,Age Group,Check In,Check Out,Amount Paid";

const PEOPLE = {
  ann: { id: "m-ann", email: "ann@example.test", firstName: "Ann", lastName: "Owner", ageTier: AgeTier.ADULT },
  bea: { id: "m-bea", email: "bea@example.test", firstName: "Bea", lastName: "Friend", ageTier: AgeTier.ADULT },
  cal: { id: "m-cal", email: "cal@example.test", firstName: "Cal", lastName: "Other", ageTier: AgeTier.ADULT },
};
type Person = (typeof PEOPLE)[keyof typeof PEOPLE];

type Line = { ref: string; owner?: Person; member?: Person; child?: string; checkIn?: string; checkOut?: string; amount?: string };

function line({ ref, owner = PEOPLE.ann, member, child, checkIn = "2026-08-10", checkOut = "2026-08-12", amount = "" }: Line) {
  const guest = member
    ? ["Member", member.email, member.firstName, member.lastName, ""]
    : ["Non-member", "", child ?? "Vic", "Visitor", child ? "Child" : "Adult"];
  return [ref, owner.email, owner.firstName, owner.lastName, ...guest, checkIn, checkOut, amount].join(",");
}

function bookings(lines: string[]): ParsedImportBooking[] {
  const result = parseBookingImportCsv([HEADER, ...lines].join("\n"));
  if (!result.ok) throw new Error(result.error);
  return result.bookings;
}

type DecidedRow = { bookingRef: string; status: BookingImportRowStatus; refusalReason: string | null; refusalCode: string | null };

function fakeDb(options: { lodge?: typeof LODGE | null; importedRefs?: string[]; decided?: DecidedRow[] } = {}) {
  const db = {
    lodge: {
      findUnique: vi.fn(async () => (options.lodge === undefined ? LODGE : options.lodge)),
      count: vi.fn(async () => 1),
    },
    member: {
      findMany: vi.fn(async () =>
        Object.values(PEOPLE).map((person) => ({ ...person, active: true, cancelledAt: null, archivedAt: null })),
      ),
    },
    season: { findMany: vi.fn(async () => []) },
    bookingImportRow: {
      findFirst: vi.fn(async ({ where }: { where: { bookingRef: string } }) =>
        (options.importedRefs ?? []).includes(where.bookingRef) ? { id: `row-${where.bookingRef}` } : null,
      ),
      findMany: vi.fn(async () => options.decided ?? []),
    },
  };
  return db as typeof db & Prisma.TransactionClient;
}

const day = (key: string) => formatStayDate(parseDateOnly(key), FORMAT);

async function plan(lines: string[], options: Parameters<typeof fakeDb>[0] & { batchId?: string } = {}) {
  const db = fakeDb(options);
  const result = await planBookingImport(db, {
    lodgeId: LODGE.id,
    bookings: bookings(lines),
    today: TODAY,
    format: FORMAT,
    batchId: options.batchId ?? null,
  });
  return { db, result };
}

beforeEach(() => {
  state.capacity = 4;
  state.held = new Map();
  state.wholeLodge = new Set();
  vi.mocked(lockBookingMemberNights).mockImplementation(async () => undefined);
  vi.mocked(findBookingMemberNightConflicts).mockImplementation(async () => []);
});

describe("planBookingImport: outcomes, totals and the digest", () => {
  it("imports bookings that pass every check, with totals, beds per night, the rate comparison and a digest of what was shown", async () => {
    state.held.set("2026-08-10", 1);
    const { result } = await plan([
      line({ ref: "B1", member: PEOPLE.ann, amount: "150.00" }),
      line({ ref: "B1", member: PEOPLE.bea }),
      line({ ref: "B2", owner: PEOPLE.cal, member: PEOPLE.cal, checkIn: "2026-08-11", checkOut: "2026-08-12", amount: "45.00" }),
    ]);

    expect(result.rows).toMatchObject([
      { bookingRef: "B1", outcome: "IMPORT", alreadyImported: false, refusals: [], amountCents: 15_000, guestCount: 2, guestNightCount: 4, appRateCents: 8_000, appRateDifferenceCents: 7_000 },
      { bookingRef: "B2", outcome: "IMPORT", refusals: [], amountCents: 4_500, guestCount: 1, guestNightCount: 1, appRateCents: 4_000, appRateDifferenceCents: 500 },
    ]);
    expect(result.rows[0]!.nights).toEqual([{ night: "2026-08-10", beds: 2 }, { night: "2026-08-11", beds: 2 }]);
    expect(result.importTotals).toEqual({ bookings: 2, guests: 3, guestNights: 5, amountCents: 19_500 });
    expect(result.refusedTotals).toEqual({ bookings: 0, guests: 0, guestNights: 0, amountCents: 0 });
    expect(result.refusedByCode).toEqual({});
    expect(result.nights).toEqual([
      { night: "2026-08-10", capacity: 4, heldBeds: 1, projectedBeds: 3, importBeds: 2, refusedBeds: 0, wholeLodgeHeld: false },
      { night: "2026-08-11", capacity: 4, heldBeds: 0, projectedBeds: 3, importBeds: 3, refusedBeds: 0, wholeLodgeHeld: false },
    ]);
    expect(result.overFullNights).toEqual([]);
    const parsed = bookings([
      line({ ref: "B1", member: PEOPLE.ann, amount: "150.00" }),
      line({ ref: "B1", member: PEOPLE.bea }),
      line({ ref: "B2", owner: PEOPLE.cal, member: PEOPLE.cal, checkIn: "2026-08-11", checkOut: "2026-08-12", amount: "45.00" }),
    ]);
    expect(result.batchKey).toBe(bookingImportBatchKey(LODGE.id, parsed));
    expect(result.digest).toBe(bookingImportPlanDigest(LODGE.id, result.rows, result.batchKey, result.nights));
  });

  it("reports a stay the app's rates cannot price with no comparison, and still imports it", async () => {
    vi.mocked(priceBookingGuestsWithMembershipTypePolicy).mockRejectedValueOnce(new Error("no season"));
    const { result } = await plan([line({ ref: "B1", member: PEOPLE.ann, amount: "100.00" })]);
    expect(result.rows[0]).toMatchObject({ outcome: "IMPORT", appRateCents: null, appRateDifferenceCents: null });
  });

  it("refuses a booking whose people do not resolve without reading capacity for it, and totals it by its first reason", async () => {
    const stranger = { ...PEOPLE.cal, email: "nobody@example.test" };
    const { result } = await plan([line({ ref: "B1", owner: stranger, member: stranger, amount: "80.00" })]);
    expect(result.rows[0]).toMatchObject({
      outcome: "REFUSED",
      refusals: [
        { code: "MEMBER", message: "The owner on line 2 matches no member" },
        { code: "MEMBER", message: "The guest on line 2 matches no member" },
      ],
      appRateCents: null,
      nights: [{ night: "2026-08-10", beds: 1 }, { night: "2026-08-11", beds: 1 }],
    });
    expect(vi.mocked(findBookingMemberNightConflicts)).not.toHaveBeenCalled();
    expect(result.importTotals.bookings).toBe(0);
    expect(result.refusedTotals).toEqual({ bookings: 1, guests: 1, guestNights: 2, amountCents: 8_000 });
    expect(result.refusedByCode).toEqual({ MEMBER: { bookings: 1, guests: 1, guestNights: 2, amountCents: 8_000 } });
    // A refused row's beds are shown as sold elsewhere, never as held here.
    expect(result.nights.map((night) => [night.importBeds, night.refusedBeds, night.projectedBeds])).toEqual([[0, 1, 0], [0, 1, 0]]);
  });

  it("refuses with a plain error when the lodge does not exist", async () => {
    await expect(plan([line({ ref: "B1", member: PEOPLE.ann, amount: "1.00" })], { lodge: null })).rejects.toThrow(
      "The lodge to import into does not exist",
    );
  });

  it("changes the digest when a reason or an outcome changes", async () => {
    const lines = [line({ ref: "B1", member: PEOPLE.ann, amount: "100.00" })];
    const clear = (await plan(lines)).result;
    vi.mocked(evaluateProposedAdultMemberHosting).mockResolvedValueOnce({ violation: true } as never);
    const refused = (await plan(lines)).result;
    expect(refused.batchKey).toBe(clear.batchKey);
    expect(refused.digest).not.toBe(clear.digest);
  });
});

describe("planBookingImport: capacity in file order", () => {
  it("lets the earlier booking take the last beds and refuses the later one, naming who fitted", async () => {
    state.capacity = 2;
    const { result } = await plan([
      line({ ref: "B1", member: PEOPLE.ann, amount: "100.00" }),
      line({ ref: "B1", member: PEOPLE.bea }),
      line({ ref: "B2", owner: PEOPLE.cal, member: PEOPLE.cal, checkIn: "2026-08-11", checkOut: "2026-08-13", amount: "60.00" }),
    ]);
    expect(result.rows.map((row) => row.outcome)).toEqual(["IMPORT", "REFUSED"]);
    expect(result.rows[1]!.refusals).toEqual([
      { code: "OVER_CAPACITY", message: `${day("2026-08-11")} would have 3 people in a 2-bed lodge` },
    ]);
    expect(result.rows[1]!.overCapacityNights).toEqual(["2026-08-11"]);
    expect(result.overFullNights).toEqual([{ night: "2026-08-11", fitted: ["B1"], refused: ["B2"] }]);
    expect(result.refusedByCode.OVER_CAPACITY).toEqual({ bookings: 1, guests: 1, guestNights: 2, amountCents: 6_000 });
    expect(result.nights.find((night) => night.night === "2026-08-11")).toMatchObject({ importBeds: 2, refusedBeds: 1, projectedBeds: 2 });
  });

  it("decides by file order: the same two bookings the other way round refuse the other one", async () => {
    state.capacity = 2;
    const { result } = await plan([
      line({ ref: "B2", owner: PEOPLE.cal, member: PEOPLE.cal, checkIn: "2026-08-11", checkOut: "2026-08-13", amount: "60.00" }),
      line({ ref: "B1", member: PEOPLE.ann, amount: "100.00" }),
      line({ ref: "B1", member: PEOPLE.bea }),
    ]);
    expect(result.rows.map((row) => [row.bookingRef, row.outcome])).toEqual([["B2", "IMPORT"], ["B1", "REFUSED"]]);
    expect(result.overFullNights).toEqual([{ night: "2026-08-11", fitted: ["B2"], refused: ["B1"] }]);
  });

  it("claims no beds for a refused booking, so a later one still fits", async () => {
    state.capacity = 1;
    const { result } = await plan([
      line({ ref: "B1", member: PEOPLE.ann, amount: "100.00", checkIn: "2026-06-20", checkOut: "2026-08-12" }),
      line({ ref: "B2", owner: PEOPLE.cal, member: PEOPLE.cal, amount: "60.00" }),
    ]);
    expect(result.rows[0]!.refusals.map((refusal) => refusal.code)).toContain("PAST_CHECK_IN");
    expect(result.rows[1]).toMatchObject({ outcome: "IMPORT", refusals: [] });
  });

  it("refuses a night under an exclusive whole-lodge hold as held, not as full", async () => {
    state.capacity = 1;
    state.held.set("2026-08-11", 5);
    state.wholeLodge.add("2026-08-11");
    const { result } = await plan([line({ ref: "B1", member: PEOPLE.ann, amount: "100.00" })]);
    expect(result.rows[0]!.refusals).toEqual([
      { code: "WHOLE_LODGE_HOLD", message: `The whole lodge is held on ${day("2026-08-11")}` },
    ]);
    expect(result.rows[0]!.overCapacityNights).toEqual([]);
    expect(result.overFullNights).toEqual([]);
    expect(result.nights.find((night) => night.night === "2026-08-11")).toMatchObject({ wholeLodgeHeld: true, refusedBeds: 1 });
  });

  it("does not claim or refuse a gap night none of the booking's guests stays", async () => {
    state.capacity = 1;
    state.held.set("2026-08-11", 1);
    const { result } = await plan([
      line({ ref: "B1", member: PEOPLE.ann, amount: "100.00", checkIn: "2026-08-10", checkOut: "2026-08-11" }),
      line({ ref: "B1", member: PEOPLE.bea, checkIn: "2026-08-12", checkOut: "2026-08-13" }),
    ]);
    expect(result.rows[0]).toMatchObject({ outcome: "IMPORT", nights: [{ night: "2026-08-10", beds: 1 }, { night: "2026-08-12", beds: 1 }] });
  });

  it("asks the capacity engine only about adjacent sold nights, never the empty months between two stays", async () => {
    await plan([
      line({ ref: "B1", member: PEOPLE.ann, amount: "10.00", checkIn: "2026-08-10", checkOut: "2026-08-11" }),
      line({ ref: "B2", owner: PEOPLE.cal, member: PEOPLE.cal, amount: "10.00", checkIn: "2027-08-10", checkOut: "2027-08-12" }),
    ]);
    const tableCalls = vi.mocked(checkCapacityForGuestRanges).mock.calls.slice(-4);
    expect(tableCalls.map(([, start, end]) => [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)])).toEqual([
      ["2026-08-10", "2026-08-11"],
      ["2026-08-10", "2026-08-11"],
      ["2027-08-10", "2027-08-12"],
      ["2027-08-10", "2027-08-12"],
    ]);
  });
});

describe("planBookingImport: the reasons a booking is refused", () => {
  it("refuses a stay that starts before the club's today", async () => {
    const { result } = await plan([line({ ref: "B1", member: PEOPLE.ann, amount: "1.00", checkIn: "2026-06-30", checkOut: "2026-07-02" })]);
    expect(result.rows[0]!.refusals).toEqual([
      { code: "PAST_CHECK_IN", message: "Check In is before today at the club; only future stays can be imported" },
    ]);
  });

  it("refuses a Booking Ref already imported into the lodge, looking past this batch's own rows", async () => {
    const { db, result } = await plan([line({ ref: "B1", member: PEOPLE.ann, amount: "1.00" })], { importedRefs: ["B1"], batchId: "batch-1" });
    expect(result.rows[0]!.refusals).toEqual([
      { code: "ALREADY_IMPORTED", message: "This Booking Ref has already been imported into this lodge" },
    ]);
    expect(db.bookingImportRow.findFirst).toHaveBeenCalledWith({
      where: { lodgeId: LODGE.id, bookingRef: "B1", status: BookingImportRowStatus.IMPORTED, batchId: { not: "batch-1" } },
      select: { id: true },
    });
  });

  it("refuses a member already on another booking in the app, naming the line and nights only", async () => {
    vi.mocked(findBookingMemberNightConflicts).mockResolvedValueOnce([
      { memberId: PEOPLE.bea.id, conflictingNights: ["2026-08-11"] },
    ] as never);
    const { result } = await plan([
      line({ ref: "B1", member: PEOPLE.ann, amount: "1.00" }),
      line({ ref: "B1", member: PEOPLE.bea }),
    ]);
    expect(result.rows[0]!.refusals).toEqual([
      { code: "PERSON_NIGHT", message: `The member on line 3 is already on another booking on ${day("2026-08-11")}` },
    ]);
  });

  it("refuses the same member on two overlapping bookings in one file, naming the earlier Booking Ref", async () => {
    const { result } = await plan([
      line({ ref: "B1", member: PEOPLE.ann, amount: "1.00" }),
      line({ ref: "B2", owner: PEOPLE.cal, member: PEOPLE.ann, amount: "1.00", checkIn: "2026-08-11", checkOut: "2026-08-14" }),
      line({ ref: "B3", owner: PEOPLE.cal, member: PEOPLE.ann, amount: "1.00", checkIn: "2026-08-12", checkOut: "2026-08-14" }),
    ]);
    expect(result.rows.map((row) => row.outcome)).toEqual(["IMPORT", "REFUSED", "IMPORT"]);
    expect(result.rows[1]!.refusals).toEqual([
      { code: "PERSON_NIGHT", message: `The member on line 3 is also on Booking Ref B1 in this file on ${day("2026-08-11")}` },
    ]);
  });

  it("refuses a party that breaks the hosting rule with the shared reason", async () => {
    vi.mocked(evaluateProposedAdultMemberHosting).mockResolvedValueOnce({ violation: true } as never);
    const { result } = await plan([line({ ref: "B1", amount: "1.00" })]);
    expect(result.rows[0]!.refusals).toEqual([BOOKING_IMPORT_HOSTING_REFUSAL]);
    expect(result.refusedByCode).toEqual({ HOSTING: { bookings: 1, guests: 1, guestNights: 2, amountCents: 100 } });
  });

  it("refuses children with no adult staying", async () => {
    const { result } = await plan([line({ ref: "B1", child: "Kit", amount: "1.00" })]);
    expect(result.rows[0]!.refusals).toEqual([
      { code: "SUPERVISION", message: "Has children with no adult staying; enter this booking through Book on Behalf" },
    ]);
  });

  it("lists every reason a booking fails, in the checking order", async () => {
    state.capacity = 0;
    vi.mocked(evaluateProposedAdultMemberHosting).mockResolvedValueOnce({ violation: true } as never);
    const { result } = await plan([line({ ref: "B1", child: "Kit", amount: "1.00", checkIn: "2026-06-30", checkOut: "2026-07-02" })], { importedRefs: ["B1"] });
    expect(result.rows[0]!.refusals.map((refusal) => refusal.code)).toEqual([
      "PAST_CHECK_IN",
      "ALREADY_IMPORTED",
      "HOSTING",
      "SUPERVISION",
      "OVER_CAPACITY",
      "OVER_CAPACITY",
    ]);
    expect(Object.keys(result.refusedByCode)).toEqual(["PAST_CHECK_IN"]);
  });
});

describe("planBookingImport: a resumed batch", () => {
  it("reports rows the batch already decided as decided, without re-checking them", async () => {
    state.held.set("2026-08-10", 1);
    state.held.set("2026-08-11", 1);
    const { result } = await plan(
      [
        line({ ref: "B1", member: PEOPLE.ann, amount: "100.00" }),
        line({ ref: "B2", owner: PEOPLE.cal, member: PEOPLE.cal, amount: "60.00" }),
        line({ ref: "B3", owner: PEOPLE.bea, member: PEOPLE.bea, amount: "70.00" }),
      ],
      {
        batchId: "batch-1",
        decided: [
          { bookingRef: "B1", status: BookingImportRowStatus.IMPORTED, refusalReason: null, refusalCode: null },
          { bookingRef: "B2", status: BookingImportRowStatus.REFUSED, refusalReason: "first reason\nsecond reason", refusalCode: "HOSTING" },
        ],
      },
    );
    expect(result.rows[0]).toMatchObject({ bookingRef: "B1", outcome: "IMPORT", alreadyImported: true, refusals: [], appRateCents: 4_000 });
    expect(result.rows[1]).toMatchObject({
      bookingRef: "B2",
      outcome: "REFUSED",
      alreadyImported: false,
      refusals: [{ code: "HOSTING", message: "first reason" }, { code: "HOSTING", message: "second reason" }],
    });
    expect(result.rows[2]).toMatchObject({ bookingRef: "B3", outcome: "IMPORT", alreadyImported: false });
    // Only the undecided row was checked.
    expect(vi.mocked(findBookingMemberNightConflicts)).toHaveBeenCalledTimes(1);
    // B1's bed is already held in the app, so it is not counted again as an import.
    expect(result.nights[0]).toMatchObject({ heldBeds: 1, importBeds: 1, refusedBeds: 1 });
  });
});

describe("checkImportBooking: the writer's locked mode", () => {
  const context: BookingImportContext = { lodge: LODGE, activeLodgeCount: 1, today: TODAY, format: FORMAT };
  const resolved: ResolvedImportBooking = {
    bookingRef: "B1",
    ownerMemberId: PEOPLE.ann.id,
    checkIn: parseDateOnly("2026-08-10"),
    checkOut: parseDateOnly("2026-08-12"),
    totalCents: 10_000,
    notes: "",
    guests: [
      { lineNumber: 2, firstName: "Ann", lastName: "Owner", ageTier: AgeTier.ADULT, isMember: true, memberId: PEOPLE.ann.id, stayStart: parseDateOnly("2026-08-10"), stayEnd: parseDateOnly("2026-08-12"), priceCents: 10_000 },
    ],
  };

  it("takes the person-night keys before reading them when locking, and only then", async () => {
    const order: string[] = [];
    vi.mocked(lockBookingMemberNights).mockImplementation(async () => void order.push("lock"));
    vi.mocked(findBookingMemberNightConflicts).mockImplementation(async () => (order.push("read"), []));
    await checkImportBooking(fakeDb(), context, resolved, { file: emptyBookingImportFileState(), batchId: "batch-1", lock: true });
    expect(order).toEqual(["lock", "read"]);
    expect(vi.mocked(lockBookingMemberNights)).toHaveBeenCalledWith(expect.anything(), [
      { memberId: PEOPLE.ann.id, stayStart: resolved.guests[0]!.stayStart, stayEnd: resolved.guests[0]!.stayEnd },
    ]);

    order.length = 0;
    await checkImportBooking(fakeDb(), context, resolved, { file: emptyBookingImportFileState(), batchId: null, lock: false });
    expect(order).toEqual(["read"]);
  });

  it("counts the file's earlier will-import guests against capacity", async () => {
    state.capacity = 1;
    const file = emptyBookingImportFileState();
    file.guests.push({ memberId: null, stayStart: parseDateOnly("2026-08-11"), stayEnd: parseDateOnly("2026-08-12") });
    const checked = await checkImportBooking(fakeDb(), context, resolved, { file, batchId: null, lock: false });
    expect(checked.overCapacityNights).toEqual(["2026-08-11"]);
    expect(checked.nights).toEqual([{ night: "2026-08-10", beds: 1 }, { night: "2026-08-11", beds: 1 }]);
  });
});
