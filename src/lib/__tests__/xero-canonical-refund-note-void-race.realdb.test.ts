/**
 * Real-PostgreSQL proof of #4223 (`INV-ADDPAY-041`): a bank-transfer
 * payment's ONE canonical refund note (`REFUND_CREDIT_NOTE`, #4091), voided
 * in Xero while a retry is recording it as its cover.
 *
 * The retry (`createXeroCreditNote`, the "already covered" branch) reads the
 * note as live outside any transaction. The inbound void then commits the
 * mirror inactive and VOIDED and releases the payment's pointer. Before #4223
 * the retry's link write, which names no Xero status, wrote the mirror back
 * active. #4195 closed the same race for a refund request's own note; the one
 * helper (`keepStoredRefundNoteVoid`) now covers both roles.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4223-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4223-member";
const LODGE_ID = "race-4223-lodge";
const BOOKING_ID = "race-4223-booking";
const PAYMENT_ID = "race-4223-payment";
const NOTE = "cn-race-4223-canonical";

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a canonical refund note voided in Xero while a retry records it stays inactive - real PostgreSQL (#4223)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Canonical refund-note void");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Canonical", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4223 Lodge", slug: "race-4223" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /** The cancellation refunded the bank transfer in full; its one note is live and named by the pointer (or not). */
    async function seed(pointer: string | null) {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "REFUNDED",
          refundedAmountCents: 20_000, xeroInvoiceId: "inv-race-4223", xeroRefundCreditNoteId: pointer,
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4223",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 20_000, watermarkCents: 20_000 },
        },
      });
    }
    beforeEach(async () => {
      await seed(NOTE);
    });

    /** Poll until a backend waits on a lock `blockerPid` holds. */
    async function waitForBlockedBy(blockerPid: number, waiterPid?: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < 10_000) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
            AND (${waiterPid ?? null}::int IS NULL OR pid = ${waiterPid ?? null}::int)
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for the retry's link write to queue behind the void held by pid ${blockerPid}.`);
    }

    /**
     * The inbound void's link write (what `reconcileXeroCreditNote` sends for a
     * VOIDED note), held open on its own connection until `release()`.
     */
    async function holdInboundVoid(status = "VOIDED") {
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let voidWritten!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (voidWritten = resolve));
      const committed = prisma.$transaction(
        async (tx) => {
          await upsertXeroObjectLink(
            {
              localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4223",
              role: "REFUND_CREDIT_NOTE", metadata: { status, total: 200 }, mergeMetadata: true,
            },
            { store: tx },
          );
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
          voidWritten(pid);
          await released;
        },
        { timeout: 30_000 },
      );
      // A failed holder must reject readiness rather than leave the test hung.
      const pid = await Promise.race([holderPid, committed.then(() => { throw new Error("Inbound void ended before reporting its lock"); })]);
      return { pid, release, committed };
    }

    /** The cancellation's refund-note retry: the note already covers it, so no Xero call is made. */
    async function retryRefundNote() {
      const apiClient = await import("@/lib/xero-api-client");
      const getClient = vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockRejectedValue(new Error("no Xero call expected (#4223)"));
      try {
        const { createXeroCreditNote } = await import("@/lib/xero-credit-notes");
        return await createXeroCreditNote(PAYMENT_ID, 20_000, { refundMethod: "internet-banking" });
      } finally {
        getClient.mockRestore();
      }
    }

    async function state() {
      const link = await prisma.xeroObjectLink.findFirstOrThrow({
        where: { localId: PAYMENT_ID, xeroObjectId: NOTE, role: "REFUND_CREDIT_NOTE" },
        select: { active: true, metadata: true },
      });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } });
      return { active: link.active, metadata: link.metadata, pointer: payment.xeroRefundCreditNoteId };
    }

    it.each(["VOIDED", "DELETED"])("a retry with no mirror waits for an inbound %s first insertion and keeps it inactive (race)", async (status) => {
      // The pointer still names the note, so the real retry finds coverage even
      // though its mirror does not exist in the retry's snapshot. A SELECT FOR
      // UPDATE alone locks nothing; the unique-key reservation must wait for
      // the inbound first insertion before the status is read.
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      const inbound = await holdInboundVoid(status);
      const retry = retryRefundNote();
      try {
        await waitForBlockedBy(inbound.pid);
      } finally {
        inbound.release();
      }
      await inbound.committed;
      expect(await retry).toBe(NOTE);
      expect(await state()).toEqual({
        active: false,
        metadata: { status, total: 200 },
        pointer: null,
      });
    });

    it("a first mirror and its inactive reservation roll back with the caller's transaction", async () => {
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      await expect(prisma.$transaction(async (tx) => {
        await upsertXeroObjectLink({
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE,
          role: "REFUND_CREDIT_NOTE", metadata: { status: "VOIDED", total: 200 },
        }, { store: tx });
        throw new Error("rollback first mirror");
      })).rejects.toThrow("rollback first mirror");
      expect(await prisma.xeroObjectLink.count({ where: { localId: PAYMENT_ID } })).toBe(0);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).xeroRefundCreditNoteId).toBe(NOTE);
    });

    it("a retry that read the canonical note as live, then waited on the inbound void, keeps the void: inactive, status kept, pointer released (race)", async () => {
      const inbound = await holdInboundVoid();
      // The retry reads the note as live (the void has not committed), finds it
      // covers the refund, and writes its link naming no status.
      const retry = retryRefundNote();
      await waitForBlockedBy(inbound.pid);
      inbound.release();
      await inbound.committed;
      expect(await retry).toBe(NOTE);

      // Before #4223 the retry wrote the voided mirror back `active: true`.
      expect(await state()).toEqual({
        active: false,
        metadata: { amountCents: 20_000, watermarkCents: 20_000, status: "VOIDED", total: 200 },
        pointer: null,
      });
    });

    it("a retry queued on the void's Payment row keeps the void and leaves the pointer clear (race)", async () => {
      // The pointer is null. The void holds the Payment row before its link
      // (#4200), so the retry cannot publish the pointer until the void commits.
      await seed(null);
      const inbound = await holdInboundVoid();
      const retry = retryRefundNote();
      await waitForBlockedBy(inbound.pid);
      inbound.release();
      await inbound.committed;
      expect(await retry).toBe(NOTE);

      // The retry's link write keeps the void and releases a pointer it put
      // back after the void committed, as the inbound write leaves it clear.
      expect(await state()).toEqual({
        active: false,
        metadata: { amountCents: 20_000, watermarkCents: 20_000, status: "VOIDED", total: 200 },
        pointer: null,
      });
    });

    it("a statusless retry keeps a stored void without waiting on a Payment row a Payment-first writer already holds (race)", async () => {
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
      // The void has committed and the pointer still names the note. An explicit
      // void holds the Payment row until that commit, so an enqueue cannot be
      // holding the row and still see this note as the live canonical one.
      // What remains is a statusless retry that keeps the void while some other
      // Payment-first writer already holds the row and waits for the link.
      const stored = { amountCents: 20_000, watermarkCents: 20_000, status: "VOIDED", total: 200 };
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID }, data: { active: false, metadata: stored } });

      const lockNote = (tx: { $executeRaw: typeof prisma.$executeRaw }) => tx.$executeRaw`
        SELECT 1 FROM "XeroObjectLink"
        WHERE "localModel" = 'Payment' AND "localId" = ${PAYMENT_ID} AND "xeroObjectType" = 'CREDIT_NOTE'
          AND "xeroObjectId" = ${NOTE} AND "role" = 'REFUND_CREDIT_NOTE'
        FOR UPDATE`;

      let releaseLink!: () => void;
      const linkRelease = new Promise<void>((resolve) => { releaseLink = resolve; });
      let holderReady!: (pid: number) => void;
      const holderPidPromise = new Promise<number>((resolve) => { holderReady = resolve; });
      const pending: Promise<unknown>[] = [];
      const holder = prisma.$transaction(async (tx) => {
        await lockNote(tx);
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
        holderReady(pid);
        await linkRelease;
      }, { timeout: 30_000 });
      pending.push(holder);
      try {
        const holderPid = await Promise.race([holderPidPromise, holder.then(() => { throw new Error("Link holder ended before locking"); })]);

        // K queues on the link first: the retry's statusless write, which keeps a stored void.
        const retry = upsertXeroObjectLink({
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE,
          role: "REFUND_CREDIT_NOTE", metadata: { amountCents: 20_000, watermarkCents: 20_000 },
        });
        void retry.catch(() => undefined);
        pending.push(retry);
        await waitForBlockedBy(holderPid);

        // F holds the Payment row, then waits for the same link, behind K.
        let paymentReady!: (pid: number) => void;
        const paymentPidPromise = new Promise<number>((resolve) => { paymentReady = resolve; });
        const paymentFirst = prisma.$transaction(async (tx) => {
          await lockPaymentForRefundedTotal(tx, PAYMENT_ID);
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
          paymentReady(pid);
          await lockNote(tx);
        }, { timeout: 30_000 });
        void paymentFirst.catch(() => undefined);
        pending.push(paymentFirst);
        const paymentPid = await Promise.race([paymentPidPromise, paymentFirst.then(() => { throw new Error("Payment-first writer ended before locking the Payment row"); })]);
        await waitForBlockedBy(holderPid, paymentPid);

        // Releasing the link lets K run while F still holds the Payment row.
        // Without SKIP LOCKED, K would wait for that row and the two would deadlock.
        const startedAt = process.hrtime.bigint();
        releaseLink();
        await Promise.race([
          retry,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Statusless retry waited on the Payment row")), 5_000)),
        ]);
        await Promise.race([
          paymentFirst,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Payment-first writer did not get the link once the retry finished")), 5_000)),
        ]);
        expect(realElapsedMs(startedAt)).toBeLessThan(5_000);
        expect(await state()).toEqual({ active: false, metadata: stored, pointer: NOTE });
      } finally {
        releaseLink();
        await Promise.allSettled(pending);
      }
    });

    it("a busy Payment defers only pointer cleanup and the nightly heal finds the inactive void", async () => {
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
      const { cleanupStaleCanonicalXeroObjectLinks } = await import("@/lib/xero-hardening-canonical-links");
      const metadata = { amountCents: 20_000, watermarkCents: 20_000, status: "VOIDED", total: 200 };
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID }, data: { active: false, metadata } });
      const committedMetadata = { ...metadata, retryCommitProbe: "busy-payment-committed" };
      let release!: () => void;
      const mayCommit = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const paymentLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = prisma.$transaction(async (tx) => {
        await lockPaymentForRefundedTotal(tx, PAYMENT_ID);
        locked();
        await mayCommit;
      }, { timeout: 30_000 });
      // A blocking-lock mutation fails the transaction or elapsed-time check;
      // the backstop still releases the holder so teardown cannot hang.
      const backstop = setTimeout(release, 10_000);
      try {
        await Promise.race([paymentLocked, holder.then(() => { throw new Error("Payment holder ended before locking"); })]);
        const startedAt = process.hrtime.bigint();
        await upsertXeroObjectLink({
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, role: "REFUND_CREDIT_NOTE",
          metadata: { retryCommitProbe: committedMetadata.retryCommitProbe },
        });
        expect(realElapsedMs(startedAt)).toBeLessThan(5_000);
        expect(await state()).toEqual({ active: false, metadata: committedMetadata, pointer: NOTE });
      } finally {
        clearTimeout(backstop);
        release();
        await holder;
      }

      const healed = await cleanupStaleCanonicalXeroObjectLinks();
      expect(healed.pointedInactiveCancelledRefundNoteMirrors).toBeGreaterThanOrEqual(1);
      expect(healed.releasedInactiveRefundNotePointers).toBeGreaterThanOrEqual(1);
      expect(await state()).toEqual({ active: false, metadata: committedMetadata, pointer: null });
    });
  },
);
