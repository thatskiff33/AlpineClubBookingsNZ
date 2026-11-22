import { describe, expect, it, vi } from "vitest";
import type { BookingStatus, WaitlistCrossLodgeOrder } from "@prisma/client";
import {
  WAITLIST_QUEUE_ORDER_BY,
  getDisplayedWaitlistPositions,
  getWaitlistPositions,
  isWaitlistPositionShown,
  orderWaitlistOffers,
  orderWaitlistOpportunities,
  splitWaitlistOpportunities,
  waitlistCandidateWhere,
  type WaitlistLapse,
  type WaitlistLapseKey,
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

  it.each([
    ["distinct join times", true],
    ["exact join-time ties", false],
  ] as const)("matches the order processWaitlistForDates walked before the extraction, in both modes (%s)", (_label, distinct) => {
    for (let seed = 1; seed <= 150; seed += 1) {
      // In the order the candidate read now returns: (createdAt, id). The old
      // read had no id tie-break, so with ties this is the one order of the
      // several it could return that the new code must reproduce exactly.
      const candidates = randomTable(seed, 12, distinct)
        .map(asEntry)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
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

  it("on an exact join-time tie under MERGED, puts every own-lodge opportunity first, then breaks by id", () => {
    const candidates = [
      asEntry(row({ id: "ca", minute: 1, lodgeId: "lodge-a", alternates: ["lodge-b"] })),
      asEntry(row({ id: "cb", minute: 1, lodgeId: "lodge-a", alternates: ["lodge-b"] })),
    ];
    const ordered = orderWaitlistOpportunities(
      splitWaitlistOpportunities(candidates, { freedLodgeId: "lodge-b", defaultLodgeId: "lodge-a" }),
      "MERGED",
    );
    expect(ordered.map((o) => `${o.candidate.id}:${o.cross ? "cross" : "own"}`)).toEqual([
      "ca:own",
      "cb:own",
      "ca:cross",
      "cb:cross",
    ]);
  });

  it("keeps a freed lodge's own entry ahead of a tied cross-lodge entry whose id sorts first, and counts positions the same way", async () => {
    // "ca" waits at lodge B and named lodge A; "cz" waits at lodge A. Same
    // instant. The offer pass at A considers cz first, so cz is #1 there.
    const rows = [
      row({ id: "ca", minute: 1, lodgeId: "lodge-b", alternates: ["lodge-a"] }),
      row({ id: "cz", minute: 1, lodgeId: "lodge-a" }),
    ];
    const ordered = orderWaitlistOpportunities(
      splitWaitlistOpportunities(rows.map(asEntry), { freedLodgeId: "lodge-a", defaultLodgeId: "lodge-a" }),
      "MERGED",
    );
    expect(
      ordered.filter((o) => o.offerLodgeId === "lodge-a").map((o) => o.candidate.id),
    ).toEqual(["cz", "ca"]);
    expect((await positionsOf(rows, "MERGED")).cz).toBe(1);
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

describe("the walk after a lapsed offer (#5410, INV-CAP-042)", () => {
  const byJoin = (rows: Row[]) =>
    [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  const keyOf = (r: Row, offeredLodgeId = r.lodgeId): WaitlistLapseKey => ({
    id: r.id,
    createdAt: r.createdAt,
    offeredLodgeId,
  });
  /** A pass's lapse: `key` is the place being re-offered; `run` every lapse of the run. */
  const lapseOf = (key: WaitlistLapseKey, run: WaitlistLapseKey[] = [key]): WaitlistLapse => ({ key, run });
  const split = (rows: Row[], freedLodgeId = "lodge-a") =>
    splitWaitlistOpportunities(byJoin(rows).map(asEntry), { freedLodgeId, defaultLodgeId: "lodge-a" });
  const walk = (
    rows: Row[],
    mode: WaitlistCrossLodgeOrder | null,
    lapse?: WaitlistLapse,
    freedLodgeId = "lodge-a",
  ) =>
    orderWaitlistOffers(split(rows, freedLodgeId), mode, lapse).map(
      (o) => `${o.candidate.id}${o.cross ? ":cross" : ""}`,
    );

  const four = () => [1, 2, 3, 4].map((n) => row({ id: `c${n}`, minute: n }));

  it.each(["OWN_LODGE_FIRST", "MERGED"] as const)(
    "walks the plain order when no lapse is passed, the way every other caller does (%s)",
    (mode) => {
      for (let seed = 1; seed <= 60; seed += 1) {
        const rows = randomTable(seed, 12, seed % 2 === 0).filter((r) => r.status === "WAITLISTED" && !r.noEmails);
        for (const freedLodgeId of LODGES) {
          const opportunities = split(rows, freedLodgeId);
          expect(orderWaitlistOffers(opportunities, mode)).toEqual(orderWaitlistOpportunities(opportunities, mode));
        }
      }
    },
  );

  it.each(["OWN_LODGE_FIRST", "MERGED"] as const)(
    "starts just after the lapsed place, wraps to the front and reaches the lapsed entry last (%s)",
    (mode) => {
      const rows = four();
      expect(walk(rows, mode, lapseOf(keyOf(rows[0]!)))).toEqual(["c2", "c3", "c4", "c1"]);
      expect(walk(rows, mode, lapseOf(keyOf(rows[1]!)))).toEqual(["c3", "c4", "c1", "c2"]);
      // Lapsed at the end of the queue: the walk wraps straight to the front.
      expect(walk(rows, mode, lapseOf(keyOf(rows[3]!)))).toEqual(["c1", "c2", "c3", "c4"]);
    },
  );

  it("re-offers a queue of one: there is nobody else to give the place to", () => {
    const only = [row({ id: "c1", minute: 1 })];
    expect(walk(only, null, lapseOf(keyOf(only[0]!)))).toEqual(["c1"]);
  });

  it("rotates by the queue's own tie-break on an exact join-time tie", () => {
    // "cb" and "ca" joined at the same instant; the queue puts "ca" first.
    const rows = [row({ id: "c1", minute: 1 }), row({ id: "cb", minute: 2 }), row({ id: "ca", minute: 2 })];
    expect(walk(rows, null)).toEqual(["c1", "ca", "cb"]);
    expect(walk(rows, null, lapseOf(keyOf(rows[2]!)))).toEqual(["cb", "c1", "ca"]);
    expect(walk(rows, null, lapseOf(keyOf(rows[1]!)))).toEqual(["c1", "ca", "cb"]);
  });

  it("leaves the order as it is when the lapsed key matches nothing", () => {
    const rows = four();
    const gone = keyOf(row({ id: "gone", minute: 2 }));
    expect(walk(rows, "MERGED", lapseOf(gone))).toEqual(["c1", "c2", "c3", "c4"]);
    // The right booking at a lodge it was never offered at matches nothing.
    expect(walk(rows, "MERGED", lapseOf(keyOf(rows[0]!, "lodge-b")))).toEqual(["c1", "c2", "c3", "c4"]);
  });

  describe("with cross-lodge opportunities at the freed lodge A", () => {
    // x1 and x2 wait at lodge B and named lodge A; a1 and a2 wait at A.
    const mixed = () => [
      row({ id: "x1", minute: 0, lodgeId: "lodge-b", alternates: ["lodge-a"] }),
      row({ id: "a1", minute: 1 }),
      row({ id: "x2", minute: 2, lodgeId: "lodge-b", alternates: ["lodge-a"] }),
      row({ id: "a2", minute: 3 }),
    ];

    it("under OWN_LODGE_FIRST rotates each part, then puts the lapse after both parts", () => {
      const rows = mixed();
      expect(walk(rows, "OWN_LODGE_FIRST")).toEqual(["x1", "a1", "x2", "a2", "x1:cross", "x2:cross"]);
      // An own-lodge lapse: the own-lodge part rotates, the cross-lodge part
      // follows, and a1 comes after the opt-ins too (owner decision, 23 Nov
      // 2026: "own lodge first" does not protect a member who just lapsed).
      expect(walk(rows, "OWN_LODGE_FIRST", lapseOf(keyOf(rows[1]!)))).toEqual([
        "x2", "a2", "x1", "x1:cross", "x2:cross", "a1",
      ]);
      // A cross-lodge lapse at A: the cross-lodge part rotates, x1's own-lodge
      // opportunity at B keeps its place, and the lapsed opportunity is last.
      expect(walk(rows, "OWN_LODGE_FIRST", lapseOf(keyOf(rows[0]!, "lodge-a")))).toEqual([
        "x1", "a1", "x2", "a2", "x2:cross", "x1:cross",
      ]);
    });

    it("under OWN_LODGE_FIRST, two own-lodge lapses go behind a waiting opt-in", () => {
      // a1 and a2 wait at A and both lapsed in one run; a3 waits at A; x waits
      // at B and named A.
      const rows = [
        row({ id: "a1", minute: 1 }),
        row({ id: "a2", minute: 2 }),
        row({ id: "x", minute: 3, lodgeId: "lodge-b", alternates: ["lodge-a"] }),
        row({ id: "a3", minute: 4 }),
      ];
      const run = [keyOf(rows[0]!), keyOf(rows[1]!)];
      expect(walk(rows, "OWN_LODGE_FIRST", lapseOf(run[0]!, run))).toEqual(["x", "a3", "x:cross", "a2", "a1"]);
      expect(walk(rows, "OWN_LODGE_FIRST", lapseOf(run[1]!, run))).toEqual(["x", "a3", "x:cross", "a1", "a2"]);
    });

    it("under OWN_LODGE_FIRST, a lone own-lodge lapse goes behind the only opt-in", () => {
      const rows = [
        row({ id: "a1", minute: 1 }),
        row({ id: "x", minute: 2, lodgeId: "lodge-b", alternates: ["lodge-a"] }),
      ];
      expect(walk(rows, "OWN_LODGE_FIRST")).toEqual(["a1", "x", "x:cross"]);
      expect(walk(rows, "OWN_LODGE_FIRST", lapseOf(keyOf(rows[0]!)))).toEqual(["x", "x:cross", "a1"]);
    });

    it("under OWN_LODGE_FIRST, a cross-lodge lapse comes after the own-lodge entries and the other opt-ins", () => {
      const rows = [
        row({ id: "x1", minute: 1, lodgeId: "lodge-b", alternates: ["lodge-a"] }),
        row({ id: "a1", minute: 2 }),
        row({ id: "x2", minute: 3, lodgeId: "lodge-b", alternates: ["lodge-a"] }),
        row({ id: "x3", minute: 4, lodgeId: "lodge-c", alternates: ["lodge-a"] }),
      ];
      expect(walk(rows, "OWN_LODGE_FIRST", lapseOf(keyOf(rows[2]!, "lodge-a")))).toEqual([
        "x1", "a1", "x2", "x3", "x3:cross", "x1:cross", "x2:cross",
      ]);
    });

    it("under MERGED rotates the one list, and a cross-lodge lapse moves only the offered lodge's opportunity last", () => {
      const rows = mixed();
      expect(walk(rows, "MERGED")).toEqual(["x1", "x1:cross", "a1", "x2", "x2:cross", "a2"]);
      expect(walk(rows, "MERGED", lapseOf(keyOf(rows[1]!)))).toEqual([
        "x2", "x2:cross", "a2", "x1", "x1:cross", "a1",
      ]);
      // x1's own-lodge opportunity wraps with everyone else who was ahead of
      // the lapsed place; only the opportunity at A is the lapse.
      expect(walk(rows, "MERGED", lapseOf(keyOf(rows[0]!, "lodge-a")))).toEqual([
        "a1", "x2", "x2:cross", "a2", "x1", "x1:cross",
      ]);
    });
  });

  describe("two offers that lapse in one run", () => {
    it("puts the run's other lapse just before the pass's own, so the queue behind them is reached", () => {
      const rows = [1, 2, 3, 4, 5].map((n) => row({ id: `c${n}`, minute: n }));
      const run = [keyOf(rows[0]!), keyOf(rows[1]!)];
      // c1's place: c2 lapsed too, so c3 is considered first.
      expect(walk(rows, null, lapseOf(run[0]!, run))).toEqual(["c3", "c4", "c5", "c2", "c1"]);
      // c2's place, once c3 holds an offer: c4 is next, then the two who lapsed.
      const withoutC3 = rows.filter((r) => r.id !== "c3");
      expect(walk(withoutC3, null, lapseOf(run[1]!, run))).toEqual(["c4", "c5", "c1", "c2"]);
    });

    it("still re-offers the two of them when nobody else is waiting", () => {
      const rows = [row({ id: "c1", minute: 1 }), row({ id: "c2", minute: 2 })];
      const run = [keyOf(rows[0]!), keyOf(rows[1]!)];
      expect(walk(rows, null, lapseOf(run[0]!, run))).toEqual(["c2", "c1"]);
      // c2 now holds the offer, so only c1 is left for c2's place.
      expect(walk([rows[0]!], null, lapseOf(run[1]!, run))).toEqual(["c1"]);
    });

    it("moves another lapse's opportunity at any lodge, not only the lodge it was offered", () => {
      // c2's offer that lapsed was a cross-lodge one at lodge B; its opportunity
      // at its own lodge A still goes behind c3 in c1's pass (owner decision,
      // 23 Nov 2026: last for every place the run re-offers).
      const rows = [
        row({ id: "c1", minute: 1 }),
        row({ id: "c2", minute: 2, alternates: ["lodge-b"] }),
        row({ id: "c3", minute: 3 }),
      ];
      const run = [keyOf(rows[0]!), keyOf(rows[1]!, "lodge-b")];
      expect(walk(rows, null, lapseOf(run[0]!, run))).toEqual(["c3", "c2", "c1"]);
    });

    it("puts a member whose cross-lodge offer lapsed behind the queue in another lapse's pass at their own lodge", () => {
      // b1 held an offer at B; x (at B, opted into A) held one at A; b2 waits
      // at B. Both offers lapse in one run. In b1's pass at B, x's own-lodge
      // opportunity goes behind b2.
      const rows = [
        row({ id: "b1", minute: 1, lodgeId: "lodge-b" }),
        row({ id: "x", minute: 2, lodgeId: "lodge-b", alternates: ["lodge-a"] }),
        row({ id: "b2", minute: 3, lodgeId: "lodge-b" }),
      ];
      const run = [keyOf(rows[0]!), keyOf(rows[1]!, "lodge-a")];
      expect(walk(rows, "OWN_LODGE_FIRST", lapseOf(run[0]!, run), "lodge-b")).toEqual(["b2", "x", "b1"]);
      // x's own pass at A: only its opportunity at A is the lapse, so its
      // own-lodge opportunity at B stays where the plain walk puts it; b1, who
      // also lapsed, goes behind the rest.
      expect(walk(rows, "OWN_LODGE_FIRST", lapseOf(run[1]!, run), "lodge-a")).toEqual([
        "x", "b2", "b1", "x:cross",
      ]);
    });

    it("moves the run's other lapses even when this pass's own key matches nothing", () => {
      const rows = four();
      const gone = keyOf(row({ id: "gone", minute: 2 }));
      expect(walk(rows, null, lapseOf(gone, [gone, keyOf(rows[1]!)]))).toEqual(["c1", "c3", "c4", "c2"]);
    });
  });

  it.each(["OWN_LODGE_FIRST", "MERGED"] as const)(
    "is a reordering of the plain walk, never a filter, with the lapse last in the whole walk (%s)",
    (mode) => {
      for (let seed = 1; seed <= 40; seed += 1) {
        const rows = randomTable(seed, 12, false).filter((r) => r.status === "WAITLISTED" && !r.noEmails);
        if (rows.length === 0) continue;
        const lapsed = rows[seed % rows.length]!;
        const run = [keyOf(lapsed), keyOf(rows[(seed * 7) % rows.length]!)];
        const rotated = walk(rows, mode, lapseOf(run[0]!, run));
        expect([...rotated].sort()).toEqual(walk(rows, mode).sort());
        // Both modes since the owner decision of 23 Nov 2026 (was: last in its
        // part under OWN_LODGE_FIRST).
        expect(rotated.at(-1)).toBe(lapsed.id);
      }
    },
  );
});
