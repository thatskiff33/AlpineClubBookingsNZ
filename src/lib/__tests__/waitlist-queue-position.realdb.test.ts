/**
 * #5402 (`INV-CAP-041`): a waitlist position is read from the live queue, and
 * agrees with the order the offer pass walks, against real PostgreSQL.
 *
 * The unit suite (`waitlist-queue.test.ts`) proves the ordering and the reader
 * against an in-memory table. What only a database can prove is here: the
 * reader's one query (envelope, `createdAt <=`, the alternate-lodge relation
 * filter, the `(createdAt, id)` order) returns the queue the offer pass reads,
 * and every real way out of the queue leaves the others numbered correctly.
 *
 * Dates sit in far-future windows no other suite uses, apart from the past-date
 * cron case, which needs a stay ending on the frozen clock's day (1 July 2026).
 * Every lodge here has capacity 0 unless a case sets it, so a sweep a writer
 * triggers after commit offers nothing the case did not ask for.
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
      name.startsWith("send") && typeof value === "function"
        ? vi.fn().mockResolvedValue(undefined)
        : value,
    ]),
  );
});
vi.mock("@/lib/session-guards", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
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
let previousCrossLodgeOrder: WaitlistCrossLodgeOrder | null = null;

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
  const response = await adminWaitlistGet(
    new NextRequest(`http://localhost/api/admin/waitlist?from=${from}&to=${to}&pageSize=100`),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { entries: Array<{ id: string; waitlistPosition: number | null }> };
  return Object.fromEntries(
    body.entries.filter((entry) => entry.id.startsWith(PREFIX)).map((entry) => [entry.id, entry.waitlistPosition]),
  );
}

async function status(id: string) {
  return (await prisma.booking.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
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
    await prisma.lodgeSettings.deleteMany({ where: { id: { in: [LODGE_A, LODGE_B] } } });
    await prisma.lodge.deleteMany({ where: { id: { in: [LODGE_A, LODGE_B] } } });
    if (previousCrossLodgeOrder === null) {
      await prisma.bookingDefaults.updateMany({ where: { id: "default" }, data: { waitlistCrossLodgeOrder: "OWN_LODGE_FIRST" } });
    } else {
      await setCrossLodgeOrder(previousCrossLodgeOrder);
    }
  });

  describe("three entries on the same nights, and every way out of the queue", () => {
    const FROM = "2031-03-10";
    const TO = "2031-03-12";
    const [E1, E2, E3] = [`${PREFIX}e1`, `${PREFIX}e2`, `${PREFIX}e3`];
    const seedThree = async (first: Partial<Entry> = {}) => {
      await seed({ id: E1, checkIn: FROM, checkOut: TO, createdAt: joined(1), ...first });
      await seed({ id: E2, checkIn: FROM, checkOut: TO, createdAt: joined(2) });
      await seed({ id: E3, checkIn: FROM, checkOut: TO, createdAt: joined(3) });
    };
    const expectEverywhere = async (expected: Record<string, number | null>) => {
      expect(await shown([E1, E2, E3])).toEqual(expected);
      const listed = await shownByAdminApi(FROM, TO);
      for (const [id, position] of Object.entries(expected)) {
        if (id in listed) expect(listed[id], `admin API position for ${id}`).toBe(position);
      }
      // The board lists every entry still waiting or offered.
      for (const id of [E2, E3]) expect(id in listed).toBe(true);
    };

    it("numbers them 1, 2, 3 on every screen", async () => {
      await seedThree();
      await expectEverywhere({ [E1]: 1, [E2]: 2, [E3]: 3 });
    });

    it("a no-payment cancel of the first leaves 1 and 2", async () => {
      await seedThree();
      const result = await cancelBooking(E1, `${E1}m`, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST);
      expect(result.status).toBe(200);
      expect(await status(E1)).toBe("CANCELLED");
      await expectEverywhere({ [E1]: null, [E2]: 1, [E3]: 2 });
    });

    it("an offer to the first leaves 1 and 2, and the offer alert quotes the first's place", async () => {
      await seedThree();
      await setCapacity(LODGE_A, 2);
      const { offeredBookingId } = await waitlist.processWaitlistForDates(
        { checkIn: day(FROM), checkOut: day(TO), lodgeId: LODGE_A },
        CLUB_FORMAT_TEST,
      );
      await setCapacity(LODGE_A, 0);
      expect(offeredBookingId).toBe(E1);
      expect(await status(E1)).toBe("WAITLIST_OFFERED");
      expect(vi.mocked(email.sendAdminWaitlistOfferAlert)).toHaveBeenCalledWith(
        expect.objectContaining({ position: 1 }),
      );
      await expectEverywhere({ [E1]: null, [E2]: 1, [E3]: 2 });
    });

    it("an expired offer with no bed free takes its original place back", async () => {
      await seedThree({ status: "WAITLIST_OFFERED", waitlistOfferExpiresAt: day("2026-06-30") });
      await expectEverywhere({ [E1]: null, [E2]: 1, [E3]: 2 });
      const result = await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      expect(result.expiredCount).toBeGreaterThanOrEqual(1);
      expect(await status(E1)).toBe("WAITLISTED");
      // The expiry email quotes the place it now holds, counting the entries
      // already waiting (the pre-#5402 count saw only other lapsed offers).
      expect(vi.mocked(email.sendWaitlistOfferExpiredEmail)).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: E1 }),
        expect.any(String),
        expect.any(String),
        day(FROM),
        day(TO),
        1,
        LODGE_A,
      );
      await expectEverywhere({ [E1]: 1, [E2]: 2, [E3]: 3 });
    });

    it("an expired offer with a bed free: records what today's code does (evidence for #5410)", async () => {
      // NOT the behaviour #5402 decides. #5410 asks whether a lapsed offer
      // should go straight back to the same member. Inferred from the code: the
      // revert keeps `createdAt`, the re-offer pass reads the queue oldest first,
      // and a WAITLIST_OFFERED booking holds no capacity, so the same booking is
      // offered again in the same run. If this case fails, the failure says what
      // the code actually does, and that is the evidence #5410 needs.
      await seedThree({ status: "WAITLIST_OFFERED", waitlistOfferExpiresAt: day("2026-06-30") });
      await setCapacity(LODGE_A, 2);
      const result = await waitlist.expireStaleOffers(CLUB_FORMAT_TEST);
      await setCapacity(LODGE_A, 0);
      expect(result.expiredCount, "expired offers in this run").toBeGreaterThanOrEqual(1);
      expect(result.reofferedCount, "re-offers in this run").toBe(1);
      expect(await status(E1), "the lapsed booking was offered straight back").toBe("WAITLIST_OFFERED");
      expect(await status(E2)).toBe("WAITLISTED");
      // Whatever #5410 decides, the numbers shown agree with the queue.
      await expectEverywhere({ [E1]: null, [E2]: 1, [E3]: 2 });
    });

    it("the past-date cron cancelling the first leaves 1 and 2", async () => {
      // The first's stay ends on the frozen clock's day; the other two overlap
      // its last night and run on.
      const [P1, P2, P3] = [`${PREFIX}p1`, `${PREFIX}p2`, `${PREFIX}p3`];
      await seed({ id: P1, checkIn: "2026-06-29", checkOut: "2026-07-01", createdAt: joined(1) });
      await seed({ id: P2, checkIn: "2026-06-30", checkOut: "2026-07-03", createdAt: joined(2) });
      await seed({ id: P3, checkIn: "2026-06-30", checkOut: "2026-07-03", createdAt: joined(3) });
      expect(await shown([P1, P2, P3])).toEqual({ [P1]: 1, [P2]: 2, [P3]: 3 });
      const result = await processWaitlistCron();
      expect(result.autoCancelled).toBeGreaterThanOrEqual(1);
      expect(await status(P1)).toBe("CANCELLED");
      expect(await shown([P1, P2, P3])).toEqual({ [P1]: null, [P2]: 1, [P3]: 2 });
    });

    it.each([
      ["force-confirmed", "PAID"],
      ["accepted offer", "PAYMENT_PENDING"],
      ["cross-lodge accept (the entry is cancelled for its replacement)", "CANCELLED"],
    ] as const)("the first leaving by %s leaves 1 and 2", async (_way, resulting) => {
      await seedThree();
      // The resulting row each writer leaves: the status, and the stored
      // position written null as every exit already does.
      await prisma.booking.update({
        where: { id: E1 },
        data: { status: resulting, waitlistPosition: null, waitlistOfferedAt: null, waitlistOfferExpiresAt: null },
      });
      await expectEverywhere({ [E1]: null, [E2]: 1, [E3]: 2 });
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
