/**
 * #5402 (`INV-CAP-041`): a waitlist position is read from the live queue, and
 * agrees with the order the offer pass walks, against real PostgreSQL.
 *
 * The unit suite (`waitlist-queue.test.ts`) proves the ordering and the reader
 * against an in-memory table. What only a database can prove is here: the
 * reader's one query (envelope, `createdAt <=`, the alternate-lodge relation
 * filter, the `(createdAt, id)` order) returns the queue the offer pass reads,
 * and every real way out of the queue leaves the others numbered correctly.
 * #5410 (`INV-CAP-042`) adds who a lapsed offer's place goes to, run end to end
 * through `expireStaleOffers`.
 *
 * Dates sit in far-future windows no other suite uses, apart from the past-date
 * cron case, which needs a stay ending on the frozen clock's day (1 July 2026).
 * Every lodge here has capacity 0 unless a case sets it, so a sweep a writer
 * triggers after commit offers nothing the case did not ask for.
 *
 * EVERY CASE HAS ITS OWN BOOKING IDS AND ITS OWN NIGHTS. The writers this suite
 * calls leave work running after they return: the audit rows (`logAudit` is not
 * awaited) and, had a cancelled booking been offered, a waitlist pass. Cancelling
 * a WAITLISTED booking starts no pass, and `expireStaleOffers` and the cron await
 * theirs, but keeping every case on its own ids and nights means nothing left
 * running from one case can read or write another case's rows, whatever capacity
 * that case sets, and a later writer added to a case cannot break that.
 *
 * THE ADMIN API HAS NO LODGE OR ID FILTER, only a date window, so
 * `shownByAdminApi` pages through the whole window (`total` rows) and keeps this
 * suite's ids; it does not depend on how many other rows share the window.
 *
 * DATABASE-WIDE WORKERS. `expireStaleOffers` and the waitlist cron act on every
 * row in the database, so their own counts are never asserted; each case
 * asserts on its own ids only.
 *
 * THIS SUITE OWNS THE CLUB-WIDE `BookingDefaults.waitlistCrossLodgeOrder` WHILE
 * IT RUNS. That is safe today because real-database files take turns on the race
 * database (`realdb-file-serialisation.ts`, #4367): no other file runs while this
 * one holds the file lock. `afterAll` puts the exact prior state back, deleting
 * the row if it did not exist before.
 */
import { NextRequest } from "next/server";
import type { BookingStatus, PrismaClient, WaitlistCrossLodgeOrder } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

vi.mock("@/lib/email", async (importOriginal) => {
  // No mail leaves a test; every sender resolves as if sent.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name === "sendWaitlistOfferEmail"
        ? vi.fn(recordOfferEmailAsSent)
        : name.startsWith("send") && typeof value === "function"
          ? vi.fn().mockResolvedValue(undefined)
          : value,
    ]),
  );
});

/**
 * #5433: whether a member was told of an offer is read from the offer email's
 * own `EmailLog` row, so "resolves as if sent" leaves the row a sent email
 * leaves: `SENT`, at its durable id. Without it the offer reads as never told,
 * and the officers' routine offer alert waits for an email that never comes.
 */
async function recordOfferEmailAsSent(context: { bookingId: string; idempotencyKey: string }, to: string) {
  const { prisma: db } = await import("@/lib/prisma");
  await db.emailLog.createMany({
    data: [{ id: `email:waitlist-offer:${context.idempotencyKey}`, to, subject: "Spot Available!", templateName: "waitlist-offer", status: "SENT", bookingId: context.bookingId }],
    skipDuplicates: true,
  });
  return { status: "sent", emailLogId: `email:waitlist-offer:${context.idempotencyKey}`, messageId: null };
}
// A full factory, never `importOriginal`: the real module imports next-auth,
// whose own `import "next/server"` does not resolve under plain Node ESM
// ("Did you mean to import next/server.js?"), so loading it fails this file
// before any test runs. The admin waitlist route needs only `requireAdmin`, and
// nothing else this suite imports reaches the module.
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({ ok: true, session: { user: { id: "wq5402admin" } } })),
}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

// Lower-case alphanumeric ids only: the database's collation and JavaScript's
// string order agree on them, which the `id` tie-break relies on.
const LODGE_A = "wq5402lodgea";
const LODGE_B = "wq5402lodgeb";
const PREFIX = "wq5402";

let prisma: PrismaClient;
let queue: typeof import("@/lib/waitlist-queue");
let waitlist: typeof import("@/lib/waitlist");
let cancelBooking: (typeof import("@/lib/booking-cancel"))["cancelBooking"];
let processWaitlistCron: (typeof import("@/lib/cron-waitlist"))["processWaitlistCron"];
let adminWaitlistGet: (typeof import("@/app/api/admin/waitlist/route"))["GET"];
let email: typeof import("@/lib/email");
/** The setting before this suite: `undefined` = not read yet, `null` = no row. */
let previousCrossLodgeOrder: WaitlistCrossLodgeOrder | null | undefined;

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const joined = (minute: number) => new Date(Date.UTC(2026, 4, 1, 9, minute));

type Entry = {
  id: string;
  lodgeId?: string;
  checkIn: string;
  checkOut: string;
  createdAt: Date;
  guests?: number;
  status?: BookingStatus;
  noEmails?: boolean;
  alternates?: string[];
  waitlistOfferExpiresAt?: Date;
  /** A cross-lodge offer's lodge (#5410). */
  offeredLodgeId?: string;
};

async function seed(entry: Entry) {
  const memberId = `${entry.id}m`;
  await prisma.member.create({
    data: {
      id: memberId,
      email: `${memberId}@example.invalid`,
      passwordHash: "not-a-real-hash",
      firstName: "Queue",
      lastName: entry.id,
      ageTier: "ADULT",
    },
  });
  const checkIn = day(entry.checkIn);
  const checkOut = day(entry.checkOut);
  await prisma.booking.create({
    data: {
      id: entry.id,
      memberId,
      lodgeId: entry.lodgeId ?? LODGE_A,
      checkIn,
      checkOut,
      status: entry.status ?? "WAITLISTED",
      noEmails: entry.noEmails ?? false,
      createdAt: entry.createdAt,
      totalPriceCents: 0,
      finalPriceCents: 0,
      waitlistOfferedAt: entry.waitlistOfferExpiresAt ? day("2026-06-28") : null,
      waitlistOfferExpiresAt: entry.waitlistOfferExpiresAt ?? null,
      waitlistOfferedLodgeId: entry.offeredLodgeId ?? null,
      waitlistOfferedPriceCents: entry.offeredLodgeId ? 0 : null,
      guests: {
        create: Array.from({ length: entry.guests ?? 2 }, (_, index) => ({
          firstName: "Guest",
          lastName: `${entry.id}${index}`,
          ageTier: "ADULT" as const,
          isMember: false,
          stayStart: checkIn,
          stayEnd: checkOut,
          priceCents: 0,
        })),
      },
      waitlistAlternateLodges: entry.alternates
        ? { create: entry.alternates.map((lodgeId) => ({ lodgeId })) }
        : undefined,
    },
  });
}

async function setCapacity(lodgeId: string, capacity: number) {
  await prisma.lodgeSettings.upsert({
    where: { id: lodgeId },
    create: { id: lodgeId, lodgeId, capacity },
    update: { capacity },
  });
}

async function setCrossLodgeOrder(order: WaitlistCrossLodgeOrder) {
  await prisma.bookingDefaults.upsert({
    where: { id: "default" },
    create: { id: "default", waitlistCrossLodgeOrder: order },
    update: { waitlistCrossLodgeOrder: order },
  });
}

async function cleanBookings() {
  const owned = { startsWith: PREFIX };
  await prisma.auditLog.deleteMany({ where: { targetId: owned } });
  // #5433: the offers and lapses this suite makes leave owed-notice markers
  // (its mocked officer alert reports nothing, so that marker stays).
  await prisma.owedNotice.deleteMany({ where: { subjectId: owned } });
  await prisma.emailLog.deleteMany({ where: { bookingId: owned } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: owned } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: owned } });
  await prisma.bookingWaitlistAlternateLodge.deleteMany({ where: { bookingId: owned } });
  await prisma.booking.deleteMany({ where: { id: owned } });
  await prisma.member.deleteMany({ where: { id: owned } });
}

/** Each booking's displayed position, read through the display reader. */
async function shown(ids: string[]): Promise<Record<string, number | null>> {
  const rows = await prisma.booking.findMany({
    where: { id: { in: ids } },
    select: { id: true, lodgeId: true, checkIn: true, checkOut: true, createdAt: true, status: true, noEmails: true },
  });
  const positions = await queue.getDisplayedWaitlistPositions(prisma, rows);
  return Object.fromEntries(ids.map((id) => [id, positions.get(id) ?? null]));
}

/** The same, through the admin waitlist API handler. Absent = not listed. */
async function shownByAdminApi(from: string, to: string): Promise<Record<string, number | null>> {
  const ours: Record<string, number | null> = {};
  for (let page = 1; ; page += 1) {
    const response = await adminWaitlistGet(
      new NextRequest(`http://localhost/api/admin/waitlist?from=${from}&to=${to}&pageSize=100&page=${page}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<{ id: string; waitlistPosition: number | null }>;
      total: number;
    };
    for (const entry of body.entries) {
      if (entry.id.startsWith(PREFIX)) ours[entry.id] = entry.waitlistPosition;
    }
    if (body.entries.length === 0 || page * 100 >= body.total) return ours;
  }
}

async function status(id: string) {
  return (await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
}

/** Each booking's status, keyed by id. */
async function statuses(ids: string[]): Promise<Record<string, BookingStatus>> {
  return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await status(id)] as const)));
}

/** Make a booking's live offer stale, as if its window had run out. */
async function lapse(id: string) {
  await prisma.booking.update({ where: { id }, data: { waitlistOfferExpiresAt: day("2026-06-30") } });
}

// #5410: the cross-lodge cases need lodge A to price their nights (November
// 2031), or the cross-lodge quote refuses every opt-in and they prove nothing.
// Each case creates the season and deletes it in its own `finally`.
const CROSS_SEASON = `${PREFIX}season`;

async function createCrossLodgeSeason() {
  const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
  await prisma.season.create({
    data: {
      id: CROSS_SEASON,
      name: "Queue 5410 cross-lodge",
      type: "WINTER",
      startDate: day("2031-11-01"),
      endDate: day("2031-11-30"),
      active: true,
      lodgeId: LODGE_A,
      membershipTypeRates: {
        create: [
          { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: 5000 },
          { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: 5000 },
        ],
      },
    },
  });
}

async function deleteCrossLodgeSeason() {
  await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: CROSS_SEASON } });
  await prisma.season.deleteMany({ where: { id: CROSS_SEASON } });
}

(RUN ? describe : describe.skip)("waitlist positions read from the live queue (#5402)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(URL, "Waitlist queue position");
    process.env.DATABASE_URL = URL;
    ({ prisma } = await import("@/lib/prisma"));
    queue = await import("@/lib/waitlist-queue");
    waitlist = await import("@/lib/waitlist");
    ({ cancelBooking } = await import("@/lib/booking-cancel"));
    ({ processWaitlistCron } = await import("@/lib/cron-waitlist"));
    ({ GET: adminWaitlistGet } = await import("@/app/api/admin/waitlist/route"));
    email = await import("@/lib/email");
    await cleanBookings();
    await deleteCrossLodgeSeason(); // left behind only by an interrupted run
    previousCrossLodgeOrder =
      (await prisma.bookingDefaults.findUnique({ where: { id: "default" }, select: { waitlistCrossLodgeOrder: true } }))
        ?.waitlistCrossLodgeOrder ?? null;
    for (const [id, name] of [[LODGE_A, "Queue lodge A"], [LODGE_B, "Queue lodge B"]] as const) {
      await prisma.lodge.upsert({
        where: { id },
        create: { id, name, slug: id, active: true },
        update: { active: true },
      });
    }
  }, 120_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanBookings();
    await setCapacity(LODGE_A, 0);
    await setCapacity(LODGE_B, 0);
    await setCrossLodgeOrder("OWN_LODGE_FIRST");
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanBookings();
    await deleteCrossLodgeSeason();
    await prisma.lodgeSettings.deleteMany({ where: { id: { in: [LODGE_A, LODGE_B] } } });
    await prisma.lodge.deleteMany({ where: { id: { in: [LODGE_A, LODGE_B] } } });
    if (previousCrossLodgeOrder === null) {
      // There was no settings row before this suite created one.
      await prisma.bookingDefaults.deleteMany({ where: { id: "default" } });
    } else if (previousCrossLodgeOrder !== undefined) {
      await setCrossLodgeOrder(previousCrossLodgeOrder);
    }
  });

  describe("three entries on the same nights, and every way out of the queue", () => {
    // Each case: its own three ids and its own two nights (see the header).
    type Three = { ids: [string, string, string]; from: string; to: string };
    let nextWindow = 0;
    const seedThree = async (tag: string, first: Partial<Entry> = {}): Promise<Three> => {
      const night = 1 + 3 * nextWindow++;
      const from = `2031-03-${String(night).padStart(2, "0")}`;
      const to = `2031-03-${String(night + 2).padStart(2, "0")}`;
      const ids: [string, string, string] = [`${PREFIX}${tag}1`, `${PREFIX}${tag}2`, `${PREFIX}${tag}3`];
      await seed({ id: ids[0], checkIn: from, checkOut: to, createdAt: joined(1), ...first });
      await seed({ id: ids[1], checkIn: from, checkOut: to, createdAt: joined(2) });
      await seed({ id: ids[2], checkIn: from, checkOut: to, createdAt: joined(3) });
      return { ids, from, to };
    };
    const expectEverywhere = async (
      { ids, from, to }: Three,
      expected: [number | null, number | null, number | null],
    ) => {
      const want = Object.fromEntries(ids.map((id, index) => [id, expected[index]]));
      expect(await shown(ids)).toEqual(want);
      const listed = await shownByAdminApi(from, to);
      for (const id of ids) {
        if (id in listed) expect(listed[id], `admin API position for ${id}`).toBe(want[id]);
      }
      // The board lists every entry still waiting or offered.
      for (const id of [ids[1], ids[2]]) expect(id in listed).toBe(true);
    };

    it("numbers them 1, 2, 3 on every screen", async () => {
      const three = await seedThree("n");
      await expectEverywhere(three, [1, 2, 3]);
    });

    it("a no-payment cancel of the first leaves 1 and 2", async () => {
      const three = await seedThree("c");
      const [first] = three.ids;
      const result = await cancelBooking(first, `${first}m`, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST);
      expect(result.status).toBe(200);
      expect(await status(first)).toBe("CANCELLED");
      await expectEverywhere(three, [null, 1, 2]);
    });

    it("an offer to the first leaves 1 and 2, and the offer alert quotes the first's place", async () => {
      const three = await seedThree("o");
      const [first] = three.ids;
      await setCapacity(LODGE_A, 2);
      const { offeredBookingId } = await waitlist.processWaitlistForDates(
        { checkIn: day(three.from), checkOut: day(three.to), lodgeId: LODGE_A },
        CLUB_FORMAT_TEST,
      );
      await setCapacity(LODGE_A, 0);
      expect(offeredBookingId).toBe(first);
      expect(await status(first)).toBe("WAITLIST_OFFERED");
      expect(vi.mocked(email.sendAdminWaitlistOfferAlert)).toHaveBeenCalledWith(
        expect.objectContaining({ position: 1, offerEmail: "sent" }),
      );
      await expectEverywhere(three, [null, 1, 2]);
    });

    it("an expired offer with no bed free takes its original place back", async () => {
      const three = await seedThree("x", { status: "WAITLIST_OFFERED", waitlistOfferExpiresAt: day("2026-06-30") });
      const [first] = three.ids;
      await expectEverywhere(three, [null, 1, 2]);
      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      expect(await status(first)).toBe("WAITLISTED");
      // The expiry email quotes the place it now holds, counting the entries
      // already waiting (the pre-#5402 count saw only other lapsed offers).
      expect(vi.mocked(email.sendWaitlistOfferExpiredEmail)).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: first }),
        expect.any(String),
        expect.any(String),
        day(three.from),
        day(three.to),
        1,
        LODGE_A,
      );
      await expectEverywhere(three, [1, 2, 3]);
    });

    it("an expired offer with a bed free goes to the next entry, and the lapsed one keeps its place (#5410)", async () => {
      // Before #5410 this case pinned the defect: the revert keeps `createdAt`
      // and an offered booking holds no capacity (`INV-CAP-011`), so the pass
      // offered the same booking straight back. `INV-CAP-042`: the pass that
      // re-offers a lapsed place now reaches the lapsed booking last.
      const three = await seedThree("r", { status: "WAITLIST_OFFERED", waitlistOfferExpiresAt: day("2026-06-30") });
      const [first, second, third] = three.ids;
      await setCapacity(LODGE_A, 2);
      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      await setCapacity(LODGE_A, 0);
      expect(await status(first), "the lapsed booking is back on the waitlist").toBe("WAITLISTED");
      expect(await status(second), "the place went to the next entry").toBe("WAITLIST_OFFERED");
      expect(await status(third)).toBe("WAITLISTED");
      expect(vi.mocked(email.sendWaitlistOfferExpiredEmail)).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: first }),
        expect.any(String),
        expect.any(String),
        day(three.from),
        day(three.to),
        1,
        LODGE_A,
      );
      // The lapsed booking keeps its number (`INV-CAP-041`); the offered one shows none.
      await expectEverywhere(three, [1, null, 2]);
    });

    it("the past-date cron cancelling the first leaves 1 and 2", async () => {
      // The first's stay ends on the frozen clock's day; the other two overlap
      // its last night and run on.
      const [P1, P2, P3] = [`${PREFIX}p1`, `${PREFIX}p2`, `${PREFIX}p3`];
      await seed({ id: P1, checkIn: "2026-06-29", checkOut: "2026-07-01", createdAt: joined(1) });
      await seed({ id: P2, checkIn: "2026-06-30", checkOut: "2026-07-03", createdAt: joined(2) });
      await seed({ id: P3, checkIn: "2026-06-30", checkOut: "2026-07-03", createdAt: joined(3) });
      expect(await shown([P1, P2, P3])).toEqual({ [P1]: 1, [P2]: 2, [P3]: 3 });
      await processWaitlistCron();
      expect(await status(P1)).toBe("CANCELLED");
      expect(await status(P2)).toBe("WAITLISTED");
      expect(await shown([P1, P2, P3])).toEqual({ [P1]: null, [P2]: 1, [P3]: 2 });
    });

    it.each([
      ["force-confirmed", "PAID", "f"],
      ["accepted offer", "PAYMENT_PENDING", "a"],
      ["cross-lodge accept (the entry is cancelled for its replacement)", "CANCELLED", "l"],
    ] as const)("the first leaving by %s leaves 1 and 2", async (_way, resulting, tag) => {
      const three = await seedThree(tag);
      // The resulting row each writer leaves: the status, and the stored
      // position written null as every exit already does.
      await prisma.booking.update({
        where: { id: three.ids[0] },
        data: { status: resulting, waitlistPosition: null, waitlistOfferedAt: null, waitlistOfferExpiresAt: null },
      });
      await expectEverywhere(three, [null, 1, 2]);
    });
  });

  describe("a lapsed offer's place goes on down the queue (#5410, INV-CAP-042)", () => {
    // Each case: its own ids and its own two nights in October 2031 (see the
    // header). Offers hold no capacity (`INV-CAP-011`), so lodge A's two beds
    // fit every party of two here, however many offers are open.
    let nextWindow = 0;
    const seedQueue = async (tag: string, size: number, offered: number[] = [0]) => {
      const night = 1 + 3 * nextWindow++;
      const from = `2031-10-${String(night).padStart(2, "0")}`;
      const to = `2031-10-${String(night + 2).padStart(2, "0")}`;
      const ids = Array.from({ length: size }, (_, index) => `${PREFIX}${tag}${index + 1}`);
      for (const [index, id] of ids.entries()) {
        await seed({
          id,
          checkIn: from,
          checkOut: to,
          createdAt: joined(index + 1),
          ...(offered.includes(index) ? { status: "WAITLIST_OFFERED" as const, waitlistOfferExpiresAt: day("2026-06-30") } : {}),
        });
      }
      return { ids, from, to };
    };

    it("passes the place on down the queue as offers lapse in turn, and wraps to the front last", async () => {
      const { ids } = await seedQueue("t", 3);
      const [first, second, third] = ids as [string, string, string];
      await setCapacity(LODGE_A, 2);
      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      expect(await statuses(ids)).toEqual({ [first]: "WAITLISTED", [second]: "WAITLIST_OFFERED", [third]: "WAITLISTED" });

      // The second lets it lapse too: the third is reached, not the first.
      await lapse(second);
      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      expect(await statuses(ids)).toEqual({ [first]: "WAITLISTED", [second]: "WAITLISTED", [third]: "WAITLIST_OFFERED" });
      expect(await shown(ids)).toEqual({ [first]: 1, [second]: 2, [third]: null });

      // Everyone has had a turn, so the place wraps round to the first.
      await lapse(third);
      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      await setCapacity(LODGE_A, 0);
      expect(await statuses(ids)).toEqual({ [first]: "WAITLIST_OFFERED", [second]: "WAITLISTED", [third]: "WAITLISTED" });
      expect(await shown(ids)).toEqual({ [first]: null, [second]: 1, [third]: 2 });
    });

    it("re-offers a queue of one: there is nobody else to give the place to", async () => {
      const { ids } = await seedQueue("one", 1);
      const [only] = ids as [string];
      await setCapacity(LODGE_A, 2);
      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      await setCapacity(LODGE_A, 0);
      const after = await prisma.booking.findUniqueOrThrow({
        where: { id: only },
        select: { status: true, waitlistOfferedAt: true },
      });
      expect(after.status).toBe("WAITLIST_OFFERED");
      // A fresh offer made in this run (the seeded lapsed one was stamped 28 June).
      expect(after.waitlistOfferedAt!.getTime()).toBeGreaterThan(day("2026-06-28").getTime());
    });

    it("gives two places that lapse in one run to the two entries behind, not back to each other", async () => {
      const { ids } = await seedQueue("w", 4, [0, 1]);
      const [first, second, third, fourth] = ids as [string, string, string, string];
      await setCapacity(LODGE_A, 4);
      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      await setCapacity(LODGE_A, 0);
      expect(await statuses(ids)).toEqual({
        [first]: "WAITLISTED",
        [second]: "WAITLISTED",
        [third]: "WAITLIST_OFFERED",
        [fourth]: "WAITLIST_OFFERED",
      });
      expect(await shown(ids)).toEqual({ [first]: 1, [second]: 2, [third]: null, [fourth]: null });
    });

    it("considers the lapsed entry in plain queue order when a different place frees later", async () => {
      // "later", not "d": `${PREFIX}d1`..`d3` belong to the date-boundary case.
      const { ids, from, to } = await seedQueue("later", 3);
      const [first, second, third] = ids as [string, string, string];
      await setCapacity(LODGE_A, 2);
      await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      expect(await status(second)).toBe("WAITLIST_OFFERED");
      // Another place frees on the same nights (a cancellation, say): that pass
      // carries no lapse, so the first, still first in the queue, is offered it.
      const { offeredBookingId } = await waitlist.processWaitlistForDates(
        { checkIn: day(from), checkOut: day(to), lodgeId: LODGE_A },
        CLUB_FORMAT_TEST,
      );
      await setCapacity(LODGE_A, 0);
      expect(offeredBookingId).toBe(first);
      expect(await statuses(ids)).toEqual({ [first]: "WAITLIST_OFFERED", [second]: "WAITLIST_OFFERED", [third]: "WAITLISTED" });
    });

    it("passes a lapsed cross-lodge offer to the next opt-in at the offered lodge", async () => {
      // Both wait at lodge B (no room) and named lodge A (room, and priced).
      // The first's offer of lodge A lapses.
      const [x1, x2] = [`${PREFIX}xl1`, `${PREFIX}xl2`];
      const nights = { checkIn: "2031-11-10", checkOut: "2031-11-12" };
      await createCrossLodgeSeason();
      try {
        await seed({
          id: x1, lodgeId: LODGE_B, ...nights, createdAt: joined(1), alternates: [LODGE_A],
          status: "WAITLIST_OFFERED", waitlistOfferExpiresAt: day("2026-06-30"), offeredLodgeId: LODGE_A,
        });
        await seed({ id: x2, lodgeId: LODGE_B, ...nights, createdAt: joined(2), alternates: [LODGE_A] });
        await setCapacity(LODGE_A, 2);
        await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
        const rows = await prisma.booking.findMany({
          where: { id: { in: [x1, x2] } },
          select: { id: true, status: true, waitlistOfferedLodgeId: true },
          orderBy: { id: "asc" },
        });
        expect(rows).toEqual([
          { id: x1, status: "WAITLISTED", waitlistOfferedLodgeId: null },
          { id: x2, status: "WAITLIST_OFFERED", waitlistOfferedLodgeId: LODGE_A },
        ]);
        // The expiry email quotes the first's place at its own lodge, where it is still first.
        expect(vi.mocked(email.sendWaitlistOfferExpiredEmail)).toHaveBeenCalledWith(
          expect.objectContaining({ bookingId: x1 }),
          expect.any(String),
          expect.any(String),
          day(nights.checkIn),
          day(nights.checkOut),
          1,
          LODGE_B,
        );
        // Not vacuous: a later pass with no lapse offers the first lodge A, so
        // the quote does price it and only the lapse rule passed it over.
        const { offeredBookingId } = await waitlist.processWaitlistForDates(
          { checkIn: day(nights.checkIn), checkOut: day(nights.checkOut), lodgeId: LODGE_A },
          CLUB_FORMAT_TEST,
        );
        expect(offeredBookingId).toBe(x1);
      } finally {
        // Bookings do not reference a season, so the season can go now.
        await setCapacity(LODGE_A, 0);
        await deleteCrossLodgeSeason();
      }
    });

    it("under OWN_LODGE_FIRST, offers the place to a waiting opt-in before the lodge's own member who let it lapse", async () => {
      // Owner decision, 23 Nov 2026: "own lodge first" does not protect a member
      // whose offer just lapsed. The only lodge-A entry's offer lapses; an opt-in
      // from lodge B (no room there) that fits lodge A is waiting behind it.
      await setCrossLodgeOrder("OWN_LODGE_FIRST");
      const [own, optIn] = [`${PREFIX}olf1`, `${PREFIX}olfx`];
      const nights = { checkIn: "2031-11-20", checkOut: "2031-11-22" };
      await createCrossLodgeSeason();
      try {
        await seed({ id: own, ...nights, createdAt: joined(1), status: "WAITLIST_OFFERED", waitlistOfferExpiresAt: day("2026-06-30") });
        await seed({ id: optIn, lodgeId: LODGE_B, ...nights, createdAt: joined(2), alternates: [LODGE_A] });
        await setCapacity(LODGE_A, 2);
        await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
        const rows = await prisma.booking.findMany({
          where: { id: { in: [own, optIn] } },
          select: { id: true, status: true, waitlistOfferedLodgeId: true },
          orderBy: { id: "asc" },
        });
        expect(rows).toEqual([
          { id: own, status: "WAITLISTED", waitlistOfferedLodgeId: null },
          { id: optIn, status: "WAITLIST_OFFERED", waitlistOfferedLodgeId: LODGE_A },
        ]);
        // The lapsed member keeps its number at its own lodge.
        expect(await shown([own])).toEqual({ [own]: 1 });
        expect(vi.mocked(email.sendWaitlistOfferExpiredEmail)).toHaveBeenCalledWith(
          expect.objectContaining({ bookingId: own }),
          expect.any(String),
          expect.any(String),
          day(nights.checkIn),
          day(nights.checkOut),
          1,
          LODGE_A,
        );
        // Not vacuous: a pass with no lapse offers the lodge's own member, so it
        // could be offered and only the lapse rule put the opt-in ahead (before
        // the decision, the own-lodge part came first and it was re-offered).
        const { offeredBookingId } = await waitlist.processWaitlistForDates(
          { checkIn: day(nights.checkIn), checkOut: day(nights.checkOut), lodgeId: LODGE_A },
          CLUB_FORMAT_TEST,
        );
        expect(offeredBookingId).toBe(own);
      } finally {
        await setCapacity(LODGE_A, 0);
        await deleteCrossLodgeSeason();
      }
    });
  });

  describe.each(["OWN_LODGE_FIRST", "MERGED"] as const)(
    "the offer pass offers the lowest-numbered entry that fits (%s)",
    (mode) => {
      const FROM = "2031-05-10";
      const TO = "2031-05-12";
      const ids = {
        crossOptIn: `${PREFIX}c1`,
        tooBig: `${PREFIX}x1`,
        silenced: `${PREFIX}s1`,
        tieA: `${PREFIX}tiea`,
        tieB: `${PREFIX}tieb`,
      };

      it("skips the party that does not fit, the silenced entry, and breaks the exact tie by id", async () => {
        await setCrossLodgeOrder(mode);
        // The oldest entry waits at lodge B and named lodge A; its party of three
        // cannot fit lodge A's two beds either.
        await seed({ id: ids.crossOptIn, lodgeId: LODGE_B, checkIn: FROM, checkOut: TO, createdAt: joined(0), guests: 3, alternates: [LODGE_A] });
        await seed({ id: ids.tooBig, checkIn: FROM, checkOut: TO, createdAt: joined(1), guests: 3 });
        await seed({ id: ids.silenced, checkIn: FROM, checkOut: TO, createdAt: joined(2), noEmails: true });
        // An exact createdAt tie, created in the reverse of id order.
        await seed({ id: ids.tieB, checkIn: FROM, checkOut: TO, createdAt: joined(3) });
        await seed({ id: ids.tieA, checkIn: FROM, checkOut: TO, createdAt: joined(3) });

        const ahead = mode === "MERGED" ? 1 : 0; // the older opt-in counts only under MERGED
        expect(await shown(Object.values(ids))).toEqual({
          [ids.crossOptIn]: 1,
          [ids.tooBig]: 1 + ahead,
          [ids.silenced]: null,
          [ids.tieA]: 2 + ahead,
          [ids.tieB]: 3 + ahead,
        });

        await setCapacity(LODGE_A, 2);
        const { offeredBookingId } = await waitlist.processWaitlistForDates(
          { checkIn: day(FROM), checkOut: day(TO), lodgeId: LODGE_A },
          CLUB_FORMAT_TEST,
        );
        await setCapacity(LODGE_A, 0);
        expect(offeredBookingId).toBe(ids.tieA);
        expect(await shown(Object.values(ids))).toEqual({
          [ids.crossOptIn]: 1,
          [ids.tooBig]: 1 + ahead,
          [ids.silenced]: null,
          [ids.tieA]: null,
          [ids.tieB]: 2 + ahead,
        });
      });
    },
  );

  describe("real date boundaries and batch reads", () => {
    it("treats a stay checking out on another's first night as not overlapping it", async () => {
      const [early, late, spanning] = [`${PREFIX}d1`, `${PREFIX}d2`, `${PREFIX}d3`];
      await seed({ id: early, checkIn: "2031-07-08", checkOut: "2031-07-10", createdAt: joined(1) });
      await seed({ id: late, checkIn: "2031-07-10", checkOut: "2031-07-12", createdAt: joined(2) });
      await seed({ id: spanning, checkIn: "2031-07-09", checkOut: "2031-07-11", createdAt: joined(3) });
      expect(await shown([early, late, spanning])).toEqual({ [early]: 1, [late]: 1, [spanning]: 3 });
    });

    it("under MERGED, keeps the lodge's own entry ahead of a tied opt-in from another lodge whose id sorts first", async () => {
      await setCrossLodgeOrder("MERGED");
      const [crossFirstId, ownLaterId] = [`${PREFIX}tieacross`, `${PREFIX}tiezown`];
      await seed({ id: crossFirstId, lodgeId: LODGE_B, checkIn: "2031-08-10", checkOut: "2031-08-12", createdAt: joined(5), alternates: [LODGE_A] });
      await seed({ id: ownLaterId, checkIn: "2031-08-10", checkOut: "2031-08-12", createdAt: joined(5) });
      // Own lodge before cross-lodge on an exact createdAt tie, whatever the ids.
      expect(await shown([crossFirstId, ownLaterId])).toEqual({ [crossFirstId]: 1, [ownLaterId]: 1 });
    });

    it.each(["OWN_LODGE_FIRST", "MERGED"] as const)(
      "gives the same numbers in one batch as one at a time on a larger queue (%s)",
      async (mode) => {
        await setCrossLodgeOrder(mode);
        const entries: Entry[] = Array.from({ length: 30 }, (_, index) => {
          const start = 10 + (index % 5);
          const lodgeId = index % 3 === 0 ? LODGE_B : LODGE_A;
          return {
            id: `${PREFIX}b${String(index).padStart(2, "0")}`,
            lodgeId,
            checkIn: `2031-09-${start}`,
            checkOut: `2031-09-${start + 1 + (index % 3)}`,
            // Each pair shares an exact join time, to exercise the id tie-break.
            createdAt: joined(Math.floor(index / 2)),
            noEmails: index % 11 === 5,
            status: index % 13 === 7 ? "WAITLIST_OFFERED" : "WAITLISTED",
            alternates: index % 4 === 1 ? [lodgeId === LODGE_A ? LODGE_B : LODGE_A] : undefined,
          };
        });
        for (const entry of entries) await seed(entry);
        const ids = entries.map((entry) => entry.id);
        const batch = await shown(ids);
        expect(Math.max(...Object.values(batch).map((n) => n ?? 0))).toBeGreaterThanOrEqual(3);
        for (const id of ids) {
          expect((await shown([id]))[id], `single read of ${id}`).toBe(batch[id]);
        }
        expect(await shownByAdminApi("2031-09-01", "2031-09-30")).toEqual(
          Object.fromEntries(ids.map((id) => [id, batch[id]])),
        );
      },
    );
  });
});
