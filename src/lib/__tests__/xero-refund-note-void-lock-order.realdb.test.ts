/**
 * Real-PostgreSQL proof of #4200: an inbound void of a payment's refund
 * credit note and a refund-note create's record lock the Payment row and
 * then that note's `XeroObjectLink`, in that order.
 *
 * Before the fix the void locked the link and then waited on the Payment
 * row. A create that already held the Payment row and needed the link to
 * retire it deadlocked (40P01). Here the create holds the Payment row, the
 * real void write waits on that row and holds no link lock, and the create
 * then locks the link. Both commit: the mirror is inactive and the pointer
 * is clear.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4200-`
 * fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4200-member";
const LODGE_ID = "race-4200-lodge";
const BOOKING_ID = "race-4200-booking";
const PAYMENT_ID = "race-4200-payment";
const NOTE = "cn-race-4200";

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "an inbound refund-note void and a create lock the payment before the link - real PostgreSQL (#4200)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Refund-note void lock order");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Void", lastName: "Order", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4200 Lodge", slug: "race-4200" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "REFUNDED",
          refundedAmountCents: 20_000, xeroInvoiceId: "inv-race-4200", xeroRefundCreditNoteId: NOTE,
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4200",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 20_000, watermarkCents: 20_000 },
        },
      });
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    async function waitForBlockedBy(blockerPid: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < 10_000) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for the void to queue behind pid ${blockerPid}.`);
    }

    async function waiterPid(blockerPid: number): Promise<number> {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
      `;
      if (rows.length !== 1) throw new Error(`Expected one void waiting on pid ${blockerPid}, saw ${rows.length}.`);
      return rows[0]!.pid;
    }

    /** The table of the tuple lock the waiter has asked for and not been granted. */
    async function rowWaitedOn(blockerPid: number): Promise<string[]> {
      const rows = await prisma.$queryRaw<Array<{ relname: string }>>`
        SELECT DISTINCT c.relname FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'tuple' AND NOT l.granted AND ${blockerPid}::int = ANY(pg_blocking_pids(a.pid))
      `;
      return rows.map((row) => row.relname).sort();
    }

    async function grantedLinkLocks(pid: number): Promise<number> {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count" FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = ${pid} AND l.granted AND l.locktype = 'tuple' AND c.relname = 'XeroObjectLink'
      `;
      return rows[0]?.count ?? 0;
    }

    it("a refund-note create holding the Payment row takes the voided note's link while the void waits, and both commit", async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let continueToLink!: () => void;
      const takeTheLink = new Promise<void>((resolve) => { continueToLink = resolve; });
      let linkTaken!: () => void;
      const linkHeld = new Promise<void>((resolve) => { linkTaken = resolve; });
      let reportPid!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => { reportPid = resolve; });

      const held = prisma.$transaction(async (tx) => {
        const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
        await lockPaymentForRefundedTotal(tx, PAYMENT_ID);
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
        reportPid(pid);
        await takeTheLink;
        // The lock the create's record needs in order to retire this note. If
        // the void already held the link, this waits out the transaction.
        await tx.$executeRaw`
          SELECT 1 FROM "XeroObjectLink"
          WHERE "localModel" = 'Payment' AND "localId" = ${PAYMENT_ID} AND "xeroObjectType" = 'CREDIT_NOTE'
            AND "xeroObjectId" = ${NOTE} AND "role" = 'REFUND_CREDIT_NOTE'
          FOR UPDATE`;
        linkTaken();
        await released;
      }, { timeout: 30_000 });

      const voidWrite = (async () => {
        const pid = await Promise.race([holderPid, held.then(() => { throw new Error("Create holder ended before locking the Payment row"); })]);
        const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
        const writing = upsertXeroObjectLink({
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4200",
          role: "REFUND_CREDIT_NOTE", metadata: { status: "VOIDED", total: 200 }, mergeMetadata: true,
        });
        await waitForBlockedBy(pid);
        const waiter = await waiterPid(pid);
        expect(await rowWaitedOn(pid)).toEqual(["Payment"]);
        expect(await grantedLinkLocks(waiter)).toBe(0);
        const startedAt = process.hrtime.bigint();
        continueToLink();
        await linkHeld;
        expect(realElapsedMs(startedAt)).toBeLessThan(5_000);
        release();
        await writing;
      })();

      try {
        await voidWrite;
        await held;
        const link = await prisma.xeroObjectLink.findFirstOrThrow({
          where: { localId: PAYMENT_ID, xeroObjectId: NOTE, role: "REFUND_CREDIT_NOTE" },
          select: { active: true, metadata: true },
        });
        const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } });
        expect(link.active).toBe(false);
        expect(link.metadata).toMatchObject({ status: "VOIDED", amountCents: 20_000, watermarkCents: 20_000 });
        expect(payment.xeroRefundCreditNoteId).toBeNull();
      } finally {
        continueToLink();
        release();
        await Promise.allSettled([held, voidWrite]);
      }
    });
  },
);
