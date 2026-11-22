import { describe, expect, it, vi } from "vitest";
import type { BookingStatus, WaitlistCrossLodgeOrder } from "@prisma/client";
import {
  WAITLIST_QUEUE_ORDER_BY,
  getDisplayedWaitlistPositions,
  getWaitlistPositions,
  isWaitlistPositionShown,
  orderWaitlistOpportunities,
  splitWaitlistOpportunities,
  waitlistCandidateWhere,
  type WaitlistQueueEntry,
} from "@/lib/waitlist-queue";

// #5402: one queue order for the offer pass and every position shown. The
// position reader runs here against an in-memory booking table whose
// `findMany` applies the reader's own `where`, `select` and `orderBy`, so the
// numbers come from the same filter and order the offer pass reads. The query
// itself is proven against Postgres in `waitlist-queue-position.realdb.test.ts`.

type Row = {
  id: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  createdAt: Date;
  status: BookingStatus;
  noEmails: boolean;
  alternates: string[];
};

const day = (n: number) => new Date(Date.UTC(2026, 7, n));
const at = (minute: number) => new Date(Date.UTC(2026, 5, 1, 0, minute));

function row(input: Partial<Row> & { id: string; minute: number }): Row {
  return {
    id: input.id,
    lodgeId: input.lodgeId ?? "lodge-a",
    checkIn: input.checkIn ?? day(10),
    checkOut: input.checkOut ?? day(12),
    createdAt: at(input.minute),
    status: input.status ?? "WAITLISTED",
    noEmails: input.noEmails ?? false,
    alternates: input.alternates ?? [],
  };
}

type Range = { lt?: Date; gt?: Date; lte?: Date };
type Where = {
  status?: string;
  noEmails?: boolean;
  checkIn?: Range;
  checkOut?: Range;
  createdAt?: Range;
  OR?: Array<
    | { lodgeId: { in: string[] } }
    | { waitlistAlternateLodges: { some: { lodgeId: { in: string[] } } } }
  >;
};

const KNOWN_WHERE_KEYS = new Set(["status", "noEmails", "checkIn", "checkOut", "createdAt", "OR"]);

function inRange(value: Date, range: Range | undefined): boolean {
  if (!range) return true;
  const t = value.getTime();
  if (range.lt && !(t < range.lt.getTime())) return false;
  if (range.gt && !(t > range.gt.getTime())) return false;
  if (range.lte && !(t <= range.lte.getTime())) return false;
  return true;
}

/** An in-memory `booking` table that refuses any filter it does not model. */
function fakeDb(rows: Row[], crossLodgeOrder: WaitlistCrossLodgeOrder | null) {
  const bookingFindMany = vi.fn(async (args: { where: Where; orderBy: unknown }) => {
    for (const key of Object.keys(args.where)) {
      if (!KNOWN_WHERE_KEYS.has(key)) throw new Error(`unmodelled where key ${key}`);
    }
    expect(args.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    const { where } = args;
    return rows
      .filter(
        (r) =>
          (where.status === undefined || r.status === where.status) &&
          (where.noEmails === undefined || r.noEmails === where.noEmails) &&
          inRange(r.checkIn, where.checkIn) &&
          inRange(r.checkOut, where.checkOut) &&
          inRange(r.createdAt, where.createdAt) &&
          (where.OR === undefined ||
            where.OR.some((clause) =>
              "lodgeId" in clause
                ? clause.lodgeId.in.includes(r.lodgeId)
                : r.alternates.some((lodgeId) =>
                    clause.waitlistAlternateLodges.some.lodgeId.in.includes(lodgeId),
                  ),
            )),
      )
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((r) => ({
        id: r.id,
        lodgeId: r.lodgeId,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        createdAt: r.createdAt,
        waitlistAlternateLodges: r.alternates.map((lodgeId) => ({ lodgeId })),
      }));
  });
  const bookingDefaultsFindUnique = vi.fn(async () =>
    crossLodgeOrder === null ? null : { waitlistCrossLodgeOrder: crossLodgeOrder },
  );
  const db = {
    booking: { findMany: bookingFindMany },
    bookingDefaults: { findUnique: bookingDefaultsFindUnique },
  } as unknown as Parameters<typeof getWaitlistPositions>[0];
  return { db, bookingFindMany, bookingDefaultsFindUnique };
}

async function positionsOf(
  rows: Row[],
  mode: WaitlistCrossLodgeOrder | null = "OWN_LODGE_FIRST",
): Promise<Record<string, number | null>> {
  const { db } = fakeDb(rows, mode);
  const map = await getDisplayedWaitlistPositions(db, rows);
  return Object.fromEntries(map);
}

/**
 * The opportunity order `processWaitlistForDates` walked before #5402, copied
 * verbatim apart from its inputs, as the oracle the extraction must match.
 */
function legacyInlineOrder<T extends WaitlistQueueEntry>(
  candidates: T[],
  freedLodgeId: string,
  defaultLodgeId: string,
  order: WaitlistCrossLodgeOrder,
) {
  type Opportunity = { candidate: T; offerLodgeId: string; cross: boolean };
  const ownOpportunities: Opportunity[] = candidates.map((candidate) => ({
    candidate,
    offerLodgeId: candidate.lodgeId ?? defaultLodgeId,
    cross: false,
  }));
  const crossOpportunities: Opportunity[] = candidates
    .filter(
      (candidate) =>
        (candidate.lodgeId ?? defaultLodgeId) !== freedLodgeId &&
        candidate.waitlistAlternateLodges.some((alternate) => alternate.lodgeId === freedLodgeId),
    )
    .map((candidate) => ({ candidate, offerLodgeId: freedLodgeId, cross: true }));
  if (crossOpportunities.length === 0) return ownOpportunities;
  return order === "MERGED"
    ? [...ownOpportunities, ...crossOpportunities].sort(
        (a, b) =>
          a.candidate.createdAt.getTime() - b.candidate.createdAt.getTime() ||
          Number(a.cross) - Number(b.cross),
      )
    : [...ownOpportunities, ...crossOpportunities];
}

/** A small deterministic generator, so a failure reproduces. */
function seeded(seed: number) {
  // mulberry32
  let state = seed >>> 0;
  return (n: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

const LODGES = ["lodge-a", "lodge-b", "lodge-c"];

function randomTable(seed: number, size: number, distinctJoins: boolean): Row[] {
  const next = seeded(seed);
  return Array.from({ length: size }, (_, index) => {
    const lodgeId = LODGES[next(3)]!;
    const start = 10 + next(6);
    const statusRoll = next(10);
    return row({
      id: `c${String(index).padStart(3, "0")}`,
      minute: distinctJoins ? index * 7 + next(5) : next(8),
      lodgeId,
      checkIn: day(start),
      checkOut: day(start + 1 + next(3)),
      status: statusRoll === 0 ? "WAITLIST_OFFERED" : statusRoll === 1 ? "CANCELLED" : "WAITLISTED",
      noEmails: next(8) === 0,
      alternates: LODGES.filter((other) => other !== lodgeId && next(3) === 0),
    });
  });
}

function asEntry(r: Row): WaitlistQueueEntry & Row {
  return { ...r, waitlistAlternateLodges: r.alternates.map((lodgeId) => ({ lodgeId })) };
}

describe("the queue order shared by the offer pass and the position reader", () => {
  it("reads the candidates in join order with an id tie-break, offerable entries only", () => {
    expect(WAITLIST_QUEUE_ORDER_BY).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(waitlistCandidateWhere({ checkIn: day(10), checkOut: day(12) })).toEqual({
      status: "WAITLISTED",
      noEmails: false,
      checkIn: { lt: day(12) },
      checkOut: { gt: day(10) },
    });
  });

  it("matches the order processWaitlistForDates walked before the extraction, in both modes", () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      // Distinct join times: the id tie-break is the one intended change.
      const candidates = randomTable(seed, 12, true)
        .map(asEntry)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const freedLodgeId of LODGES) {
        for (const mode of ["OWN_LODGE_FIRST", "MERGED"] as const) {
          const split = splitWaitlistOpportunities(candidates, {
            freedLodgeId,
            defaultLodgeId: "lodge-a",
          });
          const extracted = orderWaitlistOpportunities(split, mode);
          const legacy = legacyInlineOrder(candidates, freedLodgeId, "lodge-a", mode);
          expect(
            extracted.map((o) => [o.candidate.id, o.offerLodgeId, o.cross]),
          ).toEqual(legacy.map((o) => [o.candidate.id, o.offerLodgeId, o.cross]));
        }
      }
    }
  });

  it("breaks an exact join-time tie by id under MERGED, and keeps an entry's own lodge before its cross-lodge opportunity", () => {
    const candidates = [
      asEntry(row({ id: "cb", minute: 1, lodgeId: "lodge-a", alternates: ["lodge-b"] })),
      asEntry(row({ id: "ca", minute: 1, lodgeId: "lodge-a", alternates: ["lodge-b"] })),
    ];
    const ordered = orderWaitlistOpportunities(
      splitWaitlistOpportunities(candidates, { freedLodgeId: "lodge-b", defaultLodgeId: "lodge-a" }),
      "MERGED",
    );
    expect(ordered.map((o) => `${o.candidate.id}:${o.cross ? "cross" : "own"}`)).toEqual([
      "ca:own",
      "ca:cross",
      "cb:own",
      "cb:cross",
    ]);
  });

  it("needs the club's cross-lodge order only when a cross-lodge opportunity exists", () => {
    const own = [asEntry(row({ id: "c1", minute: 1 }))];
    expect(
      orderWaitlistOpportunities(
        splitWaitlistOpportunities(own, { freedLodgeId: "lodge-a", defaultLodgeId: "lodge-a" }),
        null,
      ),
    ).toHaveLength(1);
    const withCross = [asEntry(row({ id: "c1", minute: 1, alternates: ["lodge-b"] }))];
    expect(() =>
      orderWaitlistOpportunities(
        splitWaitlistOpportunities(withCross, { freedLodgeId: "lodge-b", defaultLodgeId: "lodge-a" }),
        null,
      ),
    ).toThrow(/cross-lodge order/);
  });
});

describe("getWaitlistPositions and the display rule", () => {
  const three = () => [
    row({ id: "c1", minute: 1 }),
    row({ id: "c2", minute: 2 }),
    row({ id: "c3", minute: 3 }),
  ];

  it("numbers three entries on the same nights 1, 2, 3", async () => {
    expect(await positionsOf(three())).toEqual({ c1: 1, c2: 2, c3: 3 });
  });

  it.each([
    ["cancelled", { status: "CANCELLED" as const }, null],
    ["confirmed", { status: "CONFIRMED" as const }, null],
    ["offered", { status: "WAITLIST_OFFERED" as const }, null],
    ["silenced", { noEmails: true }, null],
  ])("moves the two behind up to 1 and 2 when the first is %s", async (_label, change, first) => {
    const rows = three();
    rows[0] = { ...rows[0]!, ...change };
    expect(await positionsOf(rows)).toEqual({ c1: first, c2: 1, c3: 2 });
  });

  it("moves an entry back down when the one ahead of it is silenced and then cleared", async () => {
    const rows = three();
    rows[0] = { ...rows[0]!, noEmails: true };
    expect((await positionsOf(rows)).c3).toBe(2);
    rows[0] = { ...rows[0]!, noEmails: false };
    expect((await positionsOf(rows)).c3).toBe(3);
  });

  it("counts overlap half-open: a stay checking out on the target's first night is not ahead", async () => {
    const rows = [
      row({ id: "c1", minute: 1, checkIn: day(8), checkOut: day(10) }),
      row({ id: "c2", minute: 2, checkIn: day(11), checkOut: day(13) }),
      row({ id: "c3", minute: 3, checkIn: day(10), checkOut: day(12) }),
    ];
    expect((await positionsOf(rows)).c3).toBe(2);
  });

  it("breaks an exact join-time tie by id, the way the offer pass reads the queue", async () => {
    const rows = [row({ id: "cb", minute: 1 }), row({ id: "ca", minute: 1 })];
    expect(await positionsOf(rows)).toEqual({ ca: 1, cb: 2 });
  });

  it("ignores other lodges' queues, and their older opt-ins under OWN_LODGE_FIRST", async () => {
    const rows = [
      row({ id: "c1", minute: 1, lodgeId: "lodge-a", alternates: ["lodge-b"] }),
      row({ id: "c2", minute: 2, lodgeId: "lodge-a" }),
      row({ id: "c3", minute: 3, lodgeId: "lodge-b" }),
    ];
    expect((await positionsOf(rows, "OWN_LODGE_FIRST")).c3).toBe(1);
  });

  it("counts an older opt-in from another lodge under MERGED, but not a later one or one that named a different lodge", async () => {
    const rows = [
      row({ id: "c1", minute: 1, lodgeId: "lodge-a", alternates: ["lodge-b"] }),
      row({ id: "c2", minute: 2, lodgeId: "lodge-a", alternates: ["lodge-c"] }),
      row({ id: "c3", minute: 3, lodgeId: "lodge-b" }),
      row({ id: "c4", minute: 4, lodgeId: "lodge-a", alternates: ["lodge-b"] }),
    ];
    const positions = await positionsOf(rows, "MERGED");
    expect(positions.c3).toBe(2);
    // The opt-ins' own numbers are their own lodge's queue only.
    expect(positions.c1).toBe(1);
    expect(positions.c4).toBe(3);
  });

  it("does not count a silenced older opt-in under MERGED", async () => {
    const rows = [
      row({ id: "c1", minute: 1, lodgeId: "lodge-a", alternates: ["lodge-b"], noEmails: true }),
      row({ id: "c2", minute: 2, lodgeId: "lodge-b" }),
    ];
    expect((await positionsOf(rows, "MERGED")).c2).toBe(1);
  });

  it("reads the club setting only when another lodge's entry named the target's lodge", async () => {
    const plain = fakeDb(three(), "MERGED");
    await getWaitlistPositions(plain.db, three());
    expect(plain.bookingDefaultsFindUnique).not.toHaveBeenCalled();

    const rows = [
      row({ id: "c1", minute: 1, lodgeId: "lodge-a", alternates: ["lodge-b"] }),
      row({ id: "c2", minute: 2, lodgeId: "lodge-b" }),
    ];
    const optIn = fakeDb(rows, null);
    // A missing settings row is OWN_LODGE_FIRST.
    expect((await getWaitlistPositions(optIn.db, rows)).get("c2")).toBe(1);
    expect(optIn.bookingDefaultsFindUnique).toHaveBeenCalledTimes(1);
  });

  it("places a key by the key itself, even one the offer pass would not consider", async () => {
    const rows = three();
    rows[1] = { ...rows[1]!, status: "WAITLIST_OFFERED" };
    rows[2] = { ...rows[2]!, noEmails: true };
    const { db } = fakeDb(rows, "OWN_LODGE_FIRST");
    const positions = await getWaitlistPositions(db, rows);
    expect(Object.fromEntries(positions)).toEqual({ c1: 1, c2: 2, c3: 2 });
  });

  it("shows a number only for a WAITLISTED entry with emails on", () => {
    expect(isWaitlistPositionShown({ status: "WAITLISTED", noEmails: false })).toBe(true);
    expect(isWaitlistPositionShown({ status: "WAITLISTED", noEmails: true })).toBe(false);
    expect(isWaitlistPositionShown({ status: "WAITLIST_OFFERED", noEmails: false })).toBe(false);
    expect(isWaitlistPositionShown({ status: "PAYMENT_PENDING", noEmails: false })).toBe(false);
  });

  it("answers a whole page with one booking read and no read at all for an empty page", async () => {
    const rows = randomTable(7, 40, false);
    const { db, bookingFindMany } = fakeDb(rows, "MERGED");
    await getDisplayedWaitlistPositions(db, rows);
    expect(bookingFindMany).toHaveBeenCalledTimes(1);

    const empty = fakeDb([], "MERGED");
    expect((await getDisplayedWaitlistPositions(empty.db, [])).size).toBe(0);
    expect(empty.bookingFindMany).not.toHaveBeenCalled();
  });

  it.each(["OWN_LODGE_FIRST", "MERGED"] as const)(
    "gives the same number in a batch as on its own (%s)",
    async (mode) => {
      for (const seed of [3, 11, 29]) {
        // Repeated join times exercise the id tie-break too.
        const rows = randomTable(seed, 40, false);
        const batch = await positionsOf(rows, mode);
        for (const r of rows) {
          const { db } = fakeDb(rows, mode);
          const alone = await getDisplayedWaitlistPositions(db, [r]);
          expect(alone.get(r.id)).toBe(batch[r.id]);
        }
      }
    },
  );

  it.each(["OWN_LODGE_FIRST", "MERGED"] as const)(
    "agrees with the order the offer pass walks when a bed frees on the entry's nights (%s)",
    async (mode) => {
      for (const seed of [5, 17, 41, 97]) {
        const rows = randomTable(seed, 40, false);
        const shown = await positionsOf(rows, mode);
        // Not vacuous: the table has real queues, not forty position-ones.
        expect(Math.max(...Object.values(shown).map((n) => n ?? 0))).toBeGreaterThanOrEqual(3);
        for (const target of rows) {
          if (shown[target.id] === null) continue;
          // What processWaitlistForDates reads and walks for a freed range of
          // exactly the target's nights at the target's lodge.
          const where = waitlistCandidateWhere(target);
          const candidates = rows
            .filter(
              (r) =>
                r.status === where.status &&
                r.noEmails === where.noEmails &&
                r.checkIn < where.checkIn.lt &&
                r.checkOut > where.checkOut.gt,
            )
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                (a.id < b.id ? -1 : 1),
            )
            .map(asEntry);
          const walk = orderWaitlistOpportunities(
            splitWaitlistOpportunities(candidates, {
              freedLodgeId: target.lodgeId,
              defaultLodgeId: "lodge-a",
            }),
            mode,
          );
          const own = walk.findIndex((o) => o.candidate.id === target.id && !o.cross);
          const consideredFirst = walk
            .slice(0, own)
            .filter((o) => o.offerLodgeId === target.lodgeId).length;
          expect(shown[target.id]).toBe(consideredFirst + 1);
        }
      }
    },
  );

  it.each(["OWN_LODGE_FIRST", "MERGED"] as const)(
    "never shows a lower number to the entry the offer pass considers later, for entries on the same nights (%s)",
    async (mode) => {
      const rows = [
        ...randomTable(13, 30, false),
        // A block on identical nights, mixing lodges, opt-ins and a silenced row.
        row({ id: "d1", minute: 2, lodgeId: "lodge-b", alternates: ["lodge-a"] }),
        row({ id: "d2", minute: 3 }),
        row({ id: "d3", minute: 3, noEmails: true }),
        row({ id: "d4", minute: 4, lodgeId: "lodge-c", alternates: ["lodge-a"] }),
        row({ id: "d5", minute: 6 }),
        row({ id: "d6", minute: 6 }),
      ];
      const shown = await positionsOf(rows, mode);
      const candidates = rows
        .filter((r) => r.status === "WAITLISTED" && !r.noEmails && r.checkIn < day(12) && r.checkOut > day(10))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
        .map(asEntry);
      const walk = orderWaitlistOpportunities(
        splitWaitlistOpportunities(candidates, { freedLodgeId: "lodge-a", defaultLodgeId: "lodge-a" }),
        mode,
      );
      const sameNightsAtA = rows.filter(
        (r) =>
          r.lodgeId === "lodge-a" &&
          shown[r.id] !== null &&
          r.checkIn.getTime() === day(10).getTime() &&
          r.checkOut.getTime() === day(12).getTime(),
      );
      expect(sameNightsAtA.length).toBeGreaterThanOrEqual(3);
      const walkIndex = (id: string) => walk.findIndex((o) => o.candidate.id === id && !o.cross);
      for (const a of sameNightsAtA) {
        for (const b of sameNightsAtA) {
          if (a === b) continue;
          expect(shown[a.id]! < shown[b.id]!).toBe(walkIndex(a.id) < walkIndex(b.id));
        }
      }
    },
  );
});
