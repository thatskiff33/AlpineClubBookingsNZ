/**
 * Real-PostgreSQL proof of the bound group-settlement invoice (#3642,
 * `INV-PAY-105`).
 *
 * Every writer of a group settlement serialises on the global `lock(1)`, and
 * the rule's safety rests on three properties a mock can only imitate:
 *
 *  1. A settle that is refused under the lock REALLY rolls back the beds it
 *     claimed in the same transaction — a joiner never ends up CONFIRMED (bed
 *     held) on no bill.
 *  2. The reaper's release and the create worker's post-create fence decide
 *     the same invoice exactly once, in either order: the settlement never ends
 *     pointing at an invoice it has abandoned, and an abandoned invoice always
 *     has its VOID queued.
 *  3. Two observers abandoning one invoice converge on ONE replayable VOID row
 *     (the partial unique index on active correlation keys is only real here).
 *
 * None of the cases hopes for the interleaving: a third connection holds
 * `lock(1)` until every writer is queued behind it (read from
 * `pg_blocking_pids` on a fourth), the method the sibling race suites use.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-3642-` fixtures, and restores the club module settings it switches on.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const ORGANISER_ID = "race-3642-organiser";
const LODGE_ID = "race-3642-lodge";
const ORGANISER_BOOKING_ID = "race-3642-organiser-booking";
const GROUP_ID = "race-3642-group";
const JOIN_CODE = "RACE3642";
const SETTLEMENT_ID = "race-3642-settlement";
const CHILD_A = "race-3642-child-a";
const CHILD_B = "race-3642-child-b";
const CHILD_C = "race-3642-child-c";
// Far enough out that the Internet Banking lead time never refuses.
const CHECK_IN = new Date("2027-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

const LOCK_POLL_TIMEOUT_MS = 20_000;
const RACE_TEST_TIMEOUT_MS = 60_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeGroupSettlementRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Group-settlement race proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run group-settlement race proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Group-settlement race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Group-settlement race proof DB name must contain 'concurrency_race_1881'.");
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let createGroupSettlementIntent: (typeof import("@/lib/group-settlement"))["createGroupSettlementIntent"];
let reapStaleGroupSettlements: (typeof import("@/lib/cron-group-settlement-reaper"))["reapStaleGroupSettlements"];
let bindCreatedGroupSettlementInvoice: (typeof import("@/lib/xero-group-settlement-invoices"))["bindCreatedGroupSettlementInvoice"];
let abandonGroupSettlementInvoiceInTx: (typeof import("@/lib/xero-group-settlement-void-outbox"))["abandonGroupSettlementInvoiceInTx"];
let groupSettlementInvoiceCreateKey: (typeof import("@/lib/xero-group-settlement-invoice-outbox"))["groupSettlementInvoiceCreateKey"];
let groupSettlementInvoiceVoidKey: (typeof import("@/lib/xero-group-settlement-invoice-outbox"))["groupSettlementInvoiceVoidKey"];
let lockHolderClient: PrismaClient;
let observerClient: PrismaClient;
/** The club module settings row before this suite switched Internet Banking on. */
let savedModuleSettings: Record<string, unknown> | null = null;

(RUN ? describe : describe.skip)(
  "the bound group-settlement invoice under real concurrency — real PostgreSQL (#3642, INV-PAY-105)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    const bookingIds = [CHILD_A, CHILD_B, CHILD_C, ORGANISER_BOOKING_ID];

    async function deleteFixtures() {
      await prisma.xeroObjectLink.deleteMany({ where: { localId: SETTLEMENT_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: SETTLEMENT_ID } });
      await prisma.groupBookingSettlement.deleteMany({ where: { id: SETTLEMENT_ID } });
      await prisma.groupBooking.deleteMany({ where: { id: GROUP_ID } });
      await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: ORGANISER_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.booking.deleteMany({ where: { id: { in: [CHILD_A, CHILD_B, CHILD_C] } } });
      await prisma.booking.deleteMany({ where: { id: ORGANISER_BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: ORGANISER_ID } });
    }

    /** Sessions queued behind `blockerPid`, directly or transitively. */
    async function blockedByHolder(blockerPid: number): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        WITH RECURSIVE waits AS (
          SELECT activity.pid AS waiter, blocker.pid AS blocker
          FROM pg_stat_activity AS activity
          CROSS JOIN LATERAL unnest(pg_blocking_pids(activity.pid)) AS blocker(pid)
          WHERE activity.datname = current_database()
            AND activity.pid <> pg_backend_pid()
        ),
        chain AS (
          SELECT waiter, blocker FROM waits
          UNION
          SELECT chain.waiter, waits.blocker
          FROM chain
          JOIN waits ON waits.waiter = chain.blocker
        )
        SELECT COUNT(DISTINCT waiter)::int AS "count"
        FROM chain
        WHERE blocker = ${blockerPid}::int
      `;
      return rows[0]?.count ?? 0;
    }

    /**
     * Run the writers while a third connection holds `lock(1)`, release it only
     * once `expected` of them are queued behind it, and run `whileHeld` inside
     * the holder's transaction first (committed as the lock is released).
     */
    async function raceBehindLockOne(
      writers: Array<() => Promise<unknown>>,
      expected: number,
      diagnostic: string,
      whileHeld?: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<void>,
    ): Promise<PromiseSettledResult<unknown>[]> {
      const lockHeld = deferred();
      const writersQueued = deferred();
      let holderPid = 0;
      let holderError: unknown;
      const holder = lockHolderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            holderPid = rows[0]?.pid ?? 0;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
            lockHeld.resolve();
            await writersQueued.promise;
            if (whileHeld) await whileHeld(tx);
          },
          { maxWait: 10_000, timeout: 30_000 },
        )
        .catch((error: unknown) => {
          holderError = error;
          lockHeld.resolve();
        });
      await lockHeld.promise;
      if (holderError) {
        throw new Error(`The lock-holder connection could not hold lock(1): ${String(holderError)}`);
      }

      // Writers start one at a time, each only once the one before it is
      // queued: PostgreSQL grants a contended lock in queue order, so the order
      // they are listed in is the order they run in.
      const pending: Array<Promise<unknown>> = [];
      let seen = 0;
      let settled: PromiseSettledResult<unknown>[] = [];
      try {
        for (const [index, write] of writers.entries()) {
          pending.push(write());
          const want = Math.min(index + 1, expected);
          const startedAt = process.hrtime.bigint();
          while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
            seen = await blockedByHolder(holderPid);
            if (seen >= want) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (seen < want) break;
        }
      } finally {
        writersQueued.resolve();
        settled = await Promise.allSettled(pending);
        await holder;
      }
      if (holderError) throw holderError;
      if (seen < expected) {
        throw new Error(`Timed out waiting for ${expected} writer(s) to queue behind pid ${holderPid} — saw ${seen}. ${diagnostic}`);
      }
      return settled;
    }

    async function child(id: string, status: "CONFIRMED" | "PAYMENT_PENDING", cents: number) {
      await prisma.booking.create({
        data: {
          id,
          memberId: ORGANISER_ID,
          lodgeId: LODGE_ID,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          status,
          parentBookingId: ORGANISER_BOOKING_ID,
          organiserSettled: true,
          totalPriceCents: cents,
          finalPriceCents: cents,
        },
      });
    }

    async function boundSettlement(fields: { xeroInvoiceId: string | null; amountCents: number }) {
      await prisma.groupBookingSettlement.create({
        data: {
          id: SETTLEMENT_ID,
          groupBookingId: GROUP_ID,
          source: "INTERNET_BANKING",
          status: "PENDING",
          amountCents: fields.amountCents,
          xeroInvoiceId: fields.xeroInvoiceId,
        },
      });
      // Its first invoice attempt is on record, as the settle that bound it left it.
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "GroupBookingSettlement",
          localId: SETTLEMENT_ID,
          status: "SUCCEEDED",
          correlationKey: groupSettlementInvoiceCreateKey(SETTLEMENT_ID, 0),
          idempotencyKey: groupSettlementInvoiceCreateKey(SETTLEMENT_ID, 0),
          requestPayload: { queueType: "GROUP_SETTLEMENT_INVOICE", settlementId: SETTLEMENT_ID },
          queueType: "GROUP_SETTLEMENT_INVOICE",
        },
      });
    }

    async function abandonVoidRows(invoiceId: string) {
      return prisma.xeroSyncOperation.findMany({
        where: {
          localId: SETTLEMENT_ID,
          correlationKey: groupSettlementInvoiceVoidKey(SETTLEMENT_ID, invoiceId, "abandon"),
        },
        select: { id: true, status: true },
      });
    }

    beforeAll(async () => {
      assertSafeGroupSettlementRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ createGroupSettlementIntent } = await import("@/lib/group-settlement"));
      ({ reapStaleGroupSettlements } = await import("@/lib/cron-group-settlement-reaper"));
      ({ bindCreatedGroupSettlementInvoice } = await import("@/lib/xero-group-settlement-invoices"));
      ({ abandonGroupSettlementInvoiceInTx } = await import("@/lib/xero-group-settlement-void-outbox"));
      ({ groupSettlementInvoiceCreateKey, groupSettlementInvoiceVoidKey } = await import(
        "@/lib/xero-group-settlement-invoice-outbox"
      ));

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      lockHolderClient = createSeparateClient("race-3642-lock-holder");
      observerClient = createSeparateClient("race-3642-observer");
      await Promise.all([lockHolderClient.$connect(), observerClient.$connect()]);

      // The Internet Banking settle is gated on both modules; switch them on for
      // this suite and put the row back afterwards.
      savedModuleSettings = await prisma.clubModuleSettings.findUnique({ where: { id: "default" } });
      await prisma.clubModuleSettings.upsert({
        where: { id: "default" },
        create: { id: "default", xeroIntegration: true, internetBankingPayments: true },
        update: { xeroIntegration: true, internetBankingPayments: true },
      });

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: ORGANISER_ID,
          email: `${ORGANISER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Group",
          lastName: "Organiser",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3642 Lodge", slug: "race-3642" } });
      // The settle, reaper and worker module graphs are large; loading them is
      // not what this suite measures.
    }, RACE_TEST_TIMEOUT_MS);

    beforeEach(async () => {
      await prisma.xeroObjectLink.deleteMany({ where: { localId: SETTLEMENT_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: SETTLEMENT_ID } });
      await prisma.groupBookingSettlement.deleteMany({ where: { id: SETTLEMENT_ID } });
      await prisma.groupBooking.deleteMany({ where: { id: GROUP_ID } });
      await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: ORGANISER_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.booking.deleteMany({ where: { id: { in: [CHILD_A, CHILD_B, CHILD_C] } } });
      await prisma.booking.deleteMany({ where: { id: ORGANISER_BOOKING_ID } });
      await prisma.booking.create({
        data: {
          id: ORGANISER_BOOKING_ID,
          memberId: ORGANISER_ID,
          lodgeId: LODGE_ID,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          status: "CONFIRMED",
          totalPriceCents: 0,
          finalPriceCents: 0,
        },
      });
      await prisma.groupBooking.create({
        data: {
          id: GROUP_ID,
          organiserBookingId: ORGANISER_BOOKING_ID,
          organiserMemberId: ORGANISER_ID,
          joinCode: JOIN_CODE,
          paymentMode: "ORGANISER_PAYS",
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
      if (savedModuleSettings) {
        const { id: _id, updatedAt: _updatedAt, createdAt: _createdAt, ...restore } =
          savedModuleSettings as Record<string, unknown>;
        await prisma.clubModuleSettings.update({ where: { id: "default" }, data: restore });
      } else {
        await prisma.clubModuleSettings.deleteMany({ where: { id: "default" } });
      }
      await Promise.all([lockHolderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("a refused change to a bound settlement rolls back the bed it claimed for a late joiner", async () => {
      // A and B are on an invoice still being prepared; C joined afterwards.
      await child(CHILD_A, "CONFIRMED", 4_500);
      await child(CHILD_B, "CONFIRMED", 4_500);
      await child(CHILD_C, "PAYMENT_PENDING", 2_000);
      await boundSettlement({ xeroInvoiceId: null, amountCents: 9_000 });

      // The organiser asks for an updated invoice. While their claim waits on
      // lock(1), the create worker binds the invoice that was being prepared —
      // so the replacement they were cleared for (no invoice yet) is stale.
      const settled = await raceBehindLockOne(
        [() => createGroupSettlementIntent(JOIN_CODE, ORGANISER_ID, "internet_banking")],
        1,
        "The settle's claim transaction never queued on lock(1).",
        async (tx) => {
          await tx.groupBookingSettlement.update({
            where: { id: SETTLEMENT_ID },
            data: { xeroInvoiceId: "race-3642-inv-bound", xeroInvoiceNumber: "INV-RACE" },
          });
        },
      );

      expect(settled[0]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ code: "GROUP_SETTLEMENT_INVOICE_RETRY" }),
      });
      // The claim of C's bed rolled back with the refusal.
      const c = await prisma.booking.findUniqueOrThrow({ where: { id: CHILD_C }, select: { status: true } });
      expect(c.status).toBe("PAYMENT_PENDING");
      const settlement = await prisma.groupBookingSettlement.findUniqueOrThrow({
        where: { id: SETTLEMENT_ID },
        select: { amountCents: true, xeroInvoiceId: true },
      });
      expect(settlement).toEqual({ amountCents: 9_000, xeroInvoiceId: "race-3642-inv-bound" });
      expect(
        await prisma.xeroSyncOperation.count({
          where: { localId: SETTLEMENT_ID, operationType: "CREATE" },
        }),
      ).toBe(1);
      expect(await prisma.hostingCoverageReevaluation.count({ where: { memberId: ORGANISER_ID } })).toBe(0);
    });

    it.each([
      ["the create worker's fence first", "fence-first"],
      ["the reaper's release first", "reaper-first"],
    ] as const)("the reaper's release and the create worker's fence decide one invoice exactly once — %s", async (_label, order) => {
      await child(CHILD_A, "CONFIRMED", 9_000);
      await boundSettlement({ xeroInvoiceId: null, amountCents: 9_000 });
      const invoiceId = "race-3642-inv-late";
      // Past the reaper's first window; the release writes the (frozen) current
      // time back, so the second window, measured from it, has not run out.
      const reapAt = new Date();
      const threeDaysAgo = new Date(reapAt.getTime() - 3 * 24 * 60 * 60 * 1000);
      await prisma.$executeRaw`UPDATE "GroupBookingSettlement" SET "updatedAt" = ${threeDaysAgo} WHERE id = ${SETTLEMENT_ID}`;

      const fence = () =>
        prisma.$transaction((tx) =>
          bindCreatedGroupSettlementInvoice(tx, {
            settlementId: SETTLEMENT_ID,
            attempt: 0,
            invoice: { id: invoiceId, number: "INV-LATE", totalCents: 9_000 },
          }),
        );
      const reap = () => reapStaleGroupSettlements(reapAt);
      const settled = await raceBehindLockOne(
        order === "fence-first" ? [fence, reap] : [reap, fence],
        2,
        "The worker's fence and the reaper's release should both queue on lock(1).",
      );
      for (const outcome of settled) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
      const fenceResult = settled[order === "fence-first" ? 0 : 1] as PromiseFulfilledResult<{
        abandoned: boolean;
      }>;
      // Fence first: it binds, and the reaper then retires what it bound.
      // Reaper first: the fence finds the settlement released and abandons.
      expect(fenceResult.value.abandoned).toBe(order === "reaper-first");

      const settlement = await prisma.groupBookingSettlement.findUniqueOrThrow({
        where: { id: SETTLEMENT_ID },
        select: { status: true, xeroInvoiceId: true },
      });
      // Released, and never left pointing at the invoice it abandoned...
      expect(settlement).toEqual({ status: "FAILED", xeroInvoiceId: null });
      // ...whose VOID is queued exactly once, and whose link is kept inactive.
      expect(await abandonVoidRows(invoiceId)).toHaveLength(1);
      const link = await prisma.xeroObjectLink.findFirstOrThrow({
        where: { localId: SETTLEMENT_ID, xeroObjectId: invoiceId },
        select: { active: true },
      });
      expect(link.active).toBe(false);
      const a = await prisma.booking.findUniqueOrThrow({ where: { id: CHILD_A }, select: { status: true } });
      expect(a.status).toBe("PAYMENT_PENDING");
    });

    it("two observers abandoning one invoice converge on one VOID row", async () => {
      await child(CHILD_A, "CONFIRMED", 9_000);
      const invoiceId = "race-3642-inv-shared";
      await boundSettlement({ xeroInvoiceId: invoiceId, amountCents: 9_000 });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "GroupBookingSettlement",
          localId: SETTLEMENT_ID,
          xeroObjectType: "INVOICE",
          xeroObjectId: invoiceId,
          role: "GROUP_SETTLEMENT_INVOICE",
          active: true,
        },
      });

      const abandon = () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
          await abandonGroupSettlementInvoiceInTx(tx, {
            settlementId: SETTLEMENT_ID,
            xeroInvoiceId: invoiceId,
          });
        });
      const settled = await raceBehindLockOne(
        [abandon, abandon],
        2,
        "Both observers should queue on lock(1).",
      );
      for (const outcome of settled) {
        if (outcome.status === "rejected") throw outcome.reason;
      }

      const rows = await abandonVoidRows(invoiceId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("PENDING");
      const settlement = await prisma.groupBookingSettlement.findUniqueOrThrow({
        where: { id: SETTLEMENT_ID },
        select: { xeroInvoiceId: true },
      });
      expect(settlement.xeroInvoiceId).toBeNull();
    });
  },
);
