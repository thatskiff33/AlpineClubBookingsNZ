/**
 * Real-PostgreSQL proof of #4279 (`INV-INT-029`, `INV-ADDPAY-041`): a refund
 * credit-note repair that loses its claim after Xero voids the note leaves the
 * payment pointing at no voided note, and no live link to it.
 *
 * The schedule, through the real writers only:
 *   1. a Payment-first writer holds the payment's row;
 *   2. the inbound VOIDED (or DELETED) link write queues behind it (#4200);
 *   3. the officer's Retry claims the PARTIAL row and reaches the repair
 *      (`repairRefundCreditNoteFollowUpActions`), which reads the note as live;
 *   4. the row is released, the void commits, and the repair runs on to Xero,
 *      where it is held at the authenticated client;
 *   5. the stale-running reset hands the row back, and the repair resumes:
 *      its completion is refused, as it lost the claim.
 * Before #4279 the repair wrote the payment's pointer in its own autocommit
 * statement at step 3, queued behind the void, so it landed after the void had
 * cleared it, and nothing undid it once the completion was refused.
 *
 * Xero is faked (no provider call). Ordinary Vitest runs skip the whole file.
 * It reuses the guarded, disposable loopback PostgreSQL
 * `concurrency-lock-races.realdb.test.ts` provisions, which imports this file
 * so CI reaches it; it owns and cleans its own `race-4279-` fixtures.
 */
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4279-member";
const LODGE_ID = "race-4279-lodge";
const BOOKING_ID = "race-4279-booking";
const PAYMENT_ID = "race-4279-payment";
const OPERATION_ID = "race-4279-op";
const NOTE = "cn-race-4279";
const INVOICE_ID = "inv-race-4279";
// Built, not quoted: a quoted `*Key` literal reads to gitleaks as a secret.
const NOTE_KEY = ["race-4279", "refund-note", "key"].join("-");
const SETTLEMENT_MAPPING = "bankTransferRefundAccount";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let retry: typeof import("@/lib/xero-operation-retry");

(RUN ? describe : describe.skip)(
  "a refund-note repair that loses its claim after Xero voids the note leaves no live link to it - real PostgreSQL (#4279)",
  { timeout: 60_000 },
  () => {
    let mappingBefore: { code: string | null; itemCode: string | null } | null = null;
    const getCreditNote = vi.fn();
    const createPayments = vi.fn();
    const fakeClient = { xero: { accountingApi: { getCreditNote, createPayments } }, tenantId: "tenant-4279" };

    async function deleteFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Refund-note repair lost claim");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      retry = await import("@/lib/xero-operation-retry");
      await deleteFixtures();
      // Removed again in afterAll, so no suite later in the same database sees them
      // (privacy retention counts a leftover inactive member as an undated former
      // member). Upserted, so a run killed before its afterAll can start over the rows it left.
      // Inactive and archived, in both branches, so while it exists it never joins the
      // active population another suite counts (the induction baseline).
      const outOfPopulation = { active: false, archivedAt: new Date("2026-06-01T00:00:00.000Z") };
      await prisma.member.upsert({
        where: { id: MEMBER_ID },
        create: {
          id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Repair", lastName: "Proof",
          role: "ADMIN", ageTier: "ADULT", ...outOfPopulation,
        },
        update: outOfPopulation,
      });
      await prisma.lodge.upsert({ where: { id: LODGE_ID }, create: { id: LODGE_ID, name: "Race 4279 Lodge", slug: "race-4279" }, update: {} });
      await prisma.booking.upsert({
        where: { id: BOOKING_ID },
        create: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
        update: {},
      });
      // The club's bank-transfer refund account, so the repair pays the note (`INV-PAY-101`).
      mappingBefore = await prisma.xeroAccountMapping.findUnique({ where: { key: SETTLEMENT_MAPPING }, select: { code: true, itemCode: true } });
      await prisma.xeroAccountMapping.upsert({ where: { key: SETTLEMENT_MAPPING }, create: { key: SETTLEMENT_MAPPING, code: "090" }, update: { code: "090" } });
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      try {
        await deleteFixtures();
        // A repair's refund payment records an immutable export manifest (#4525) naming the
        // booking (ON DELETE RESTRICT), so release it and any journal rows before the booking.
        await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
        // The booking holds the foreign keys to the lodge and the member, so it goes first.
        await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
        await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
        await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      } finally {
        if (mappingBefore) await prisma.xeroAccountMapping.update({ where: { key: SETTLEMENT_MAPPING }, data: mappingBefore });
        else await prisma.xeroAccountMapping.deleteMany({ where: { key: SETTLEMENT_MAPPING } });
      }
    }, 60_000);

    /**
     * A $200 bank transfer refunded in full by one note, whose create raised the
     * note and failed its refund payment: the row is PARTIAL, the repair's to finish.
     */
    async function seed(options: { pointer: string | null; linkMetadata?: Prisma.InputJsonObject; refundRequestId?: string; settledEarlier?: true }) {
      await deleteFixtures();
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "REFUNDED",
          refundedAmountCents: 20_000, xeroInvoiceId: INVOICE_ID, xeroRefundCreditNoteId: options.pointer,
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4279",
          role: options.refundRequestId ? "REFUND_REQUEST_CREDIT_NOTE" : "REFUND_CREDIT_NOTE", active: true,
          metadata: options.linkMetadata ?? { amountCents: 20_000, watermarkCents: 20_000 },
        },
      });
      await prisma.xeroSyncOperation.create({
        data: {
          id: OPERATION_ID, direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "PARTIAL", idempotencyKey: NOTE_KEY, correlationKey: NOTE_KEY,
          requestPayload: {
            allocation: { invoiceId: INVOICE_ID, amount: 200 },
            refundMethod: "internet-banking",
            ...(options.refundRequestId ? { refundRequestId: options.refundRequestId } : {}),
          },
          // `settledEarlier`: the payment leg is done, so the repair completes with no Xero call.
          responsePayload: options.settledEarlier
            ? { refundPayment: { paymentID: "race-4279-earlier-payment" }, refundPaymentError: null, refundPaymentSkipped: false }
            : { refundPayment: null, refundPaymentError: { message: "Xero 503 on the refund payment" }, refundPaymentSkipped: false },
          xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4279", completedAt: new Date(),
        },
      });
    }

    /** What Xero answers for the note: live and unpaid, paid by `paymentId`, or voided/deleted. */
    function xeroShowsNote(state: "AUTHORISED" | "PAID" | "VOIDED" | "DELETED", paymentId?: string) {
      getCreditNote.mockResolvedValue({
        body: {
          creditNotes: [{
            creditNoteID: NOTE, creditNoteNumber: "CN-4279", status: state, total: 200, date: "2026-06-30",
            remainingCredit: state === "PAID" ? 0 : 200,
            payments: paymentId ? [{ paymentID: paymentId, amount: 200, status: "AUTHORISED" }] : [],
          }],
        },
      });
    }

    beforeEach(async () => {
      getCreditNote.mockReset();
      createPayments.mockReset();
      createPayments.mockImplementation(async () => ({
        body: { payments: [{ paymentID: `race-4279-xero-payment-${createPayments.mock.calls.length}`, amount: 200 }] },
      }));
      xeroShowsNote("AUTHORISED");
      const apiClient = await import("@/lib/xero-api-client");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue(fakeClient as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Hold the repair at its first Xero call until `open()`. */
    async function holdRepairAtXero() {
      const apiClient = await import("@/lib/xero-api-client");
      let reached!: () => void;
      const atXero = new Promise<void>((resolve) => (reached = resolve));
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      vi.mocked(apiClient.getAuthenticatedXeroClient).mockImplementationOnce(async () => {
        reached();
        await opened;
        return fakeClient as never;
      });
      return { atXero, open };
    }

    /** Backends of this database waiting on a lock: the holder's queue, direct or behind an earlier waiter. */
    async function lockWaiters(): Promise<number> {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
      return Number(n);
    }

    /** Poll until `done()` holds; a schedule that never arrives fails rather than hangs. */
    async function until(done: () => Promise<boolean>, what: string) {
      const startedAt = process.hrtime.bigint();
      while (!(await done())) {
        if (realElapsedMs(startedAt) > 10_000) throw new Error(`Timed out waiting for ${what}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    /** A Payment-first writer holding the payment's row until `release()`. */
    async function holdPaymentRow() {
      const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (locked = resolve));
      const committed = prisma.$transaction(async (tx) => {
        await lockPaymentForRefundedTotal(tx, PAYMENT_ID);
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
        locked(pid);
        await released;
      }, { timeout: 30_000 });
      const pid = await Promise.race([holderPid, committed.then(() => { throw new Error("Payment holder ended before locking"); })]);
      return { pid, release, committed };
    }

    /** The inbound sync's link write for a note Xero reports `status` (what `reconcileXeroCreditNote` sends). */
    async function inboundCancelled(status: "VOIDED" | "DELETED") {
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      return upsertXeroObjectLink({
        localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4279",
        role: "REFUND_CREDIT_NOTE", metadata: { status, total: 200 }, mergeMetadata: true,
      });
    }

    /** The stale-running reset hands the repair's claim back, as if 20 minutes had passed. */
    async function resetStaleClaim() {
      await until(async () => (await readRow()).status === "RUNNING", "the repair's claim");
      await prisma.xeroSyncOperation.update({ where: { id: OPERATION_ID }, data: { startedAt: new Date(Date.now() - 20 * 60_000) } });
      const stale = await import("@/lib/xero-stale-operations");
      const now = new Date();
      return prisma.$transaction((tx) =>
        stale.writeStaleRunningXeroOperationReset({ ...stale.staleRunningXeroOperationFilter(now), id: OPERATION_ID }, now, "stale reset (#4279)", tx),
      );
    }

    const readRow = () => prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });

    async function state() {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } });
      const liveLinks = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, active: true },
        select: { xeroObjectType: true, xeroObjectId: true, role: true },
        orderBy: { xeroObjectType: "asc" },
      });
      return { pointer: payment.xeroRefundCreditNoteId, liveLinks };
    }

    it.each(["VOIDED", "DELETED"] as const)(
      "a repair that read the note as live, then lost its claim after Xero %s it, leaves no pointer and no live link to it (race)",
      async (status) => {
        await seed({ pointer: NOTE });
        const repairAtXero = await holdRepairAtXero();
        const holder = await holdPaymentRow();
        let inbound: Promise<unknown> | undefined;
        let repair: Promise<{ message: string }> | undefined;
        try {
          inbound = inboundCancelled(status);
          await until(async () => (await lockWaiters()) === 1, "the inbound void to queue on the Payment row");
          // The repair reads the note as live: the void has not committed. Its
          // own Payment-row write, if it makes one before Xero, queues behind the void.
          repair = retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST);
          let atXero = false;
          void repairAtXero.atXero.then(() => (atXero = true));
          await until(async () => atXero || (await lockWaiters()) === 2, "the repair to reach Xero or queue behind the void");
        } finally {
          holder.release();
        }
        await holder.committed;
        await inbound;
        await repairAtXero.atXero;

        expect(await resetStaleClaim()).toEqual({ failed: 0, partial: 1 });
        repairAtXero.open();
        await expect(repair).resolves.toEqual({ message: retry.PARTIAL_REPAIR_CLAIM_LOST_MESSAGE });

        expect(await state()).toEqual({ pointer: null, liveLinks: [] });
        expect(await readRow()).toMatchObject({ status: "PARTIAL", lastErrorCode: "ORPHANED_STALE_RUNNING" });
        expect(createPayments).toHaveBeenCalledTimes(1);

        // A replay of the same void changes nothing; the next retry finds the note
        // cancelled in Xero and stops: no second payment, no pointer, no live link.
        await inboundCancelled(status);
        xeroShowsNote(status, "race-4279-xero-payment-1");
        await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).rejects.toThrow(`is ${status} in Xero`);
        expect(createPayments).toHaveBeenCalledTimes(1);
        expect(await state()).toEqual({ pointer: null, liveLinks: [] });
      },
    );

    /** A writer holding the operation row until `release()`: the completion's claim queues on it. */
    async function holdOperationRow() {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const committed = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "XeroSyncOperation" WHERE "id" = ${OPERATION_ID} FOR UPDATE`;
        locked();
        await released;
      }, { timeout: 30_000 });
      await Promise.race([holding, committed.then(() => { throw new Error("Operation-row holder ended before locking"); })]);
      return { release, committed };
    }

    it.each(["VOIDED", "DELETED"] as const)(
      "a won completion that holds the Payment row while an inbound %s waits commits first, and the void then releases its pointer (race, other order)",
      async (status) => {
        await seed({ pointer: null });
        const repairAtXero = await holdRepairAtXero();
        const repair = retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST);
        await repairAtXero.atXero;
        // The claim is won; hold its row so the completion stops after taking the Payment row.
        const operationHolder = await holdOperationRow();
        let inbound: Promise<unknown> | undefined;
        let inboundDone = false;
        try {
          repairAtXero.open();
          await until(async () => (await lockWaiters()) === 1, "the completion to queue on its claim, holding the Payment row");
          inbound = inboundCancelled(status).finally(() => (inboundDone = true));
          // Two waiters: the void cannot take the Payment row the completion holds.
          await until(async () => (await lockWaiters()) === 2, "the inbound void to queue behind the completion's Payment row");
          expect(inboundDone).toBe(false);
        } finally {
          operationHolder.release();
        }
        await operationHolder.committed;
        await expect(repair).resolves.toEqual({ message: "Repaired Xero refund credit note follow-up actions." });
        await inbound;

        // The completion adopted the live note and wrote its links; the void, after it,
        // made the note's link inactive and released the pointer. The payment's link
        // stays: it records the one payment Xero was sent, which the void does not touch.
        expect(await readRow()).toMatchObject({ status: "SUCCEEDED" });
        expect(createPayments).toHaveBeenCalledTimes(1);
        const after = await state();
        expect(after).toEqual({
          pointer: null,
          liveLinks: [{ xeroObjectType: "PAYMENT", xeroObjectId: "race-4279-xero-payment-1", role: "REFUND_PAYMENT" }],
        });

        // A replay of the void changes nothing.
        await inboundCancelled(status);
        expect(await state()).toEqual(after);
      },
    );

    it("MUTATION: a repair that loses its claim on a live note adopts nothing, and the retry after it adopts the note with no second payment", async () => {
      await seed({ pointer: null });
      const repairAtXero = await holdRepairAtXero();
      const repair = retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST);
      await repairAtXero.atXero;
      expect(await resetStaleClaim()).toEqual({ failed: 0, partial: 1 });
      repairAtXero.open();
      await expect(repair).resolves.toEqual({ message: retry.PARTIAL_REPAIR_CLAIM_LOST_MESSAGE });
      // A pointer written before the claim, or by a refused completion, would name the note here.
      expect(await state()).toEqual({
        pointer: null,
        liveLinks: [{ xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, role: "REFUND_CREDIT_NOTE" }],
      });

      // The handed-back row's next retry reads the payment the lost run sent as
      // Xero's settlement and closes on it, adopting the note under its won claim.
      xeroShowsNote("PAID", "race-4279-xero-payment-1");
      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Repaired Xero refund credit note follow-up actions.",
      });
      expect(createPayments).toHaveBeenCalledTimes(1);
      expect(await readRow()).toMatchObject({ status: "SUCCEEDED" });
      expect(await state()).toEqual({
        pointer: NOTE,
        liveLinks: [
          { xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, role: "REFUND_CREDIT_NOTE" },
          { xeroObjectType: "PAYMENT", xeroObjectId: "race-4279-xero-payment-1", role: "REFUND_PAYMENT" },
        ],
      });
    });

    it("a repair that wins its claim adopts a live note as the payment's refund note", async () => {
      await seed({ pointer: null });
      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Repaired Xero refund credit note follow-up actions.",
      });
      expect(createPayments).toHaveBeenCalledTimes(1);
      expect(await state()).toEqual({
        pointer: NOTE,
        liveLinks: [
          { xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, role: "REFUND_CREDIT_NOTE" },
          { xeroObjectType: "PAYMENT", xeroObjectId: "race-4279-xero-payment-1", role: "REFUND_PAYMENT" },
        ],
      });
    });

    it.each(["VOIDED", "DELETED"] as const)("a repair that wins its claim after an inbound %s keeps the note's link inactive and adopts nothing", async (status) => {
      await seed({ pointer: NOTE, settledEarlier: true });
      await inboundCancelled(status);
      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Repaired Xero refund credit note follow-up actions.",
      });
      expect(getCreditNote).not.toHaveBeenCalled();
      expect(await readRow()).toMatchObject({ status: "SUCCEEDED" });
      expect(await state()).toEqual({ pointer: null, liveLinks: [] });
    });

    it("a repair Xero answers with a voided note writes no pointer, before or after", async () => {
      await seed({ pointer: null });
      xeroShowsNote("VOIDED");
      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).rejects.toThrow("is VOIDED in Xero");
      expect(createPayments).not.toHaveBeenCalled();
      expect(await readRow()).toMatchObject({ status: "PARTIAL" });
      expect((await state()).pointer).toBeNull();
    });

    it("MUTATION: a per-refund note's repair, though it wins its claim, never makes it the payment's refund note (#3880 F1)", async () => {
      await seed({ pointer: null, linkMetadata: { amountCents: 20_000, perDelta: true } });
      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Repaired Xero refund credit note follow-up actions.",
      });
      expect((await state()).pointer).toBeNull();
    });

    it("a refund request's own note's repair never makes it the payment's refund note (#3827)", async () => {
      await seed({ pointer: null, refundRequestId: "race-4279-request" });
      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Repaired Xero refund credit note follow-up actions.",
      });
      const after = await state();
      expect(after.pointer).toBeNull();
      expect(after.liveLinks).toContainEqual({ xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, role: "REFUND_REQUEST_CREDIT_NOTE" });
    });
  },
);
