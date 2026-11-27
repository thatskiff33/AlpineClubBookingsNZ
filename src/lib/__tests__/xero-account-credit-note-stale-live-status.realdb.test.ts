/**
 * Real-PostgreSQL proof of #4347 (`INV-ADDPAY-041`, the owner's 24 Oct 2026
 * decision on #4288, applied to account-credit notes): an older live Xero
 * reading never revives a payment's account-credit note that a later reading
 * recorded VOIDED, and never counts its refund again.
 *
 * The worked example: a $200 Internet Banking payment, cancelled with $100
 * kept as account credit, which raised account-credit note N. Xero voids N.
 * Whether the void or an older AUTHORISED reading of N reaches the app first,
 * N's link ends VOIDED with its `active` flag as stored, and the payment ends
 * at $0 refunded. Before #4347 the account-credit link was written unjudged and
 * the recount counted the reading, so the older reading put $100 back.
 *
 * Also pinned here: the transaction boundaries the fix relies on. The inbound
 * link write locks only N's account-credit row and commits before the recount
 * takes the Payment row (`INV-LOCK-002`), so a Payment-first writer (#4200's
 * explicit refund-note void, ALP-614's completion) never waits on that link and
 * neither side deadlocks; and the account-credit allocation repair, under the
 * member's credit lock, posts nothing from a reading the note's row refused.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it, and the schedule shapes of
 * `xero-refund-note-stale-live-status.realdb.test.ts`; it owns and cleans its
 * own `race-4347-` fixtures.
 */
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4347";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BT_BOOKING = `${P}-bt-booking`;
const CARD_BOOKING = `${P}-card-booking`;
/** The member's other, live booking: the one a stale reading's allocation names. */
const LIVE_BOOKING = `${P}-live-booking`;
const BOOKINGS = [BT_BOOKING, CARD_BOOKING, LIVE_BOOKING];
/** The $200 Internet Banking payment and the $200 card control. */
const BT = `${P}-bt`;
const CARD = `${P}-card`;
const LIVE_PAYMENT = `${P}-live`;
const PAYMENTS = [BT, CARD, LIVE_PAYMENT];
const LIVE_INVOICE = `inv-${P}-live`;
/** Each payment's $100 account-credit note. */
const NOTE: Record<"bank" | "card", string> = { bank: `cn-${P}-bank`, card: `cn-${P}-card` };
/** A refund credit note on the bank payment, for the Payment-first writer. */
const REFUND_NOTE = `cn-${P}-refund`;
const SEEDED = "2026-06-30T10:00:00.000Z";
const EARLY = "2026-06-30T11:00:00.000Z";
const LATE = "2026-06-30T12:00:00.000Z";

type Kind = "bank" | "card";
const PAYMENT: Record<Kind, string> = { bank: BT, card: CARD };
const BOOKING: Record<Kind, string> = { bank: BT_BOOKING, card: CARD_BOOKING };

let prisma: (typeof import("@/lib/prisma"))["prisma"];

/** A Xero reading of a $100 account-credit note, as the SDK returns it. */
function reading(kind: Kind, status: string, updatedAt: string, allocations: Array<Record<string, unknown>> = []) {
  const allocated = allocations.reduce((sum, allocation) => sum + Number(allocation.amount ?? 0), 0);
  return {
    creditNoteID: NOTE[kind], creditNoteNumber: `CN-4347-${kind}`, type: "ACCRECCREDIT", status, total: 100,
    appliedAmount: allocated, remainingCredit: status === "VOIDED" ? 0 : 100 - allocated, updatedDateUTC: new Date(updatedAt), allocations, payments: [],
  };
}

(RUN ? describe : describe.skip)(
  "an older live Xero reading never revives a voided account-credit note or its refund - real PostgreSQL (#4347)",
  { timeout: 60_000 },
  () => {
    async function deletePaymentState() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: PAYMENTS } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: PAYMENTS } } });
      // The applied-credit allocation links a current reading writes sit on the member's credit rows, not a payment.
      const notes = [...Object.values(NOTE), REFUND_NOTE];
      await prisma.xeroObjectLink.deleteMany({
        where: { OR: [{ xeroObjectId: { in: notes } }, ...notes.map((note) => ({ metadata: { path: ["creditNoteId"], equals: note } }))] },
      });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: MEMBER_ID } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: BOOKINGS } } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: MEMBER_ID }, { subjectMemberId: MEMBER_ID }] } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: PAYMENTS } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: PAYMENTS } } });
      await prisma.payment.deleteMany({ where: { id: { in: PAYMENTS } } });
    }
    async function deleteFixtures() {
      await deletePaymentState();
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: BOOKINGS } } });
      await prisma.booking.deleteMany({ where: { id: { in: BOOKINGS } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Stale live account-credit note status");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Stale", lastName: "Credit", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4347 Lodge", slug: "race-4347" } });
      for (const id of BOOKINGS) {
        await prisma.booking.create({
          data: {
            id, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: id === LIVE_BOOKING ? "CONFIRMED" : "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
            checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
          },
        });
      }
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /**
     * Each $200 payment counts its $100 account-credit note, recorded live by
     * an earlier reading: the cancellation credit the note was raised for
     * (which the inbound resolver finds the payment by) and the payment's
     * ACCOUNT_CREDIT_NOTE link. The member's live booking has its own payment.
     */
    async function seed() {
      await deletePaymentState();
      await prisma.payment.create({
        data: { id: BT, bookingId: BT_BOOKING, amountCents: 20_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED", refundedAmountCents: 10_000, xeroInvoiceId: `inv-${P}-bt` },
      });
      // The control: a card ledger is raised by Xero, never lowered (`INV-ADDPAY-021`), and capped at Stripe's refunds (#4444).
      await prisma.payment.create({
        data: { id: CARD, bookingId: CARD_BOOKING, amountCents: 20_000, source: "STRIPE", status: "SUCCEEDED", refundedAmountCents: 0, xeroInvoiceId: `inv-${P}-card` },
      });
      await prisma.payment.create({
        data: { id: LIVE_PAYMENT, bookingId: LIVE_BOOKING, amountCents: 20_000, source: "INTERNET_BANKING", status: "SUCCEEDED", refundedAmountCents: 0, xeroInvoiceId: LIVE_INVOICE },
      });
      for (const kind of ["bank", "card"] as const) {
        await prisma.memberCredit.create({
          data: { memberId: MEMBER_ID, amountCents: 10_000, type: "CANCELLATION_REFUND", description: `Cancellation credit (${kind})`, sourceBookingId: BOOKING[kind], xeroCreditNoteId: NOTE[kind] },
        });
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "Payment", localId: PAYMENT[kind], xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE[kind], xeroObjectNumber: `CN-4347-${kind}`,
            role: "ACCOUNT_CREDIT_NOTE", active: true,
            metadata: { status: "AUTHORISED", total: 100, appliedAmount: 0, remainingCredit: 100, providerUpdatedAt: SEEDED },
          },
        });
      }
    }

    /** A fake Xero (no provider call) answering `current()`, and no alert, for the length of `run`. */
    async function withFakeXero<T>(current: (id: string) => unknown, run: () => Promise<T>): Promise<T> {
      const apiClient = await import("@/lib/xero-api-client");
      const alerts = await import("@/lib/xero-error-alert");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({
          xero: { accountingApi: { getCreditNote: async (_tenant: string, id: string) => ({ body: { creditNotes: [current(id)] } }) } },
          tenantId: "tenant-4347",
        } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** The real inbound reconcile of one reading. */
    async function reconcile(kind: Kind, note: ReturnType<typeof reading>) {
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      return withFakeXero(() => note, () => reconcileXeroCreditNote(NOTE[kind]));
    }

    /** The real inbound reconcile of `note`, paused at `gate` after its link reads and before its writes. */
    async function pausedReconcile(kind: Kind, note: ReturnType<typeof reading>, gate: Promise<void>, reached: () => void) {
      const objectLinks = await import("@/lib/xero-inbound/object-links");
      const original = objectLinks.findActiveXeroObjectLinks;
      const spy = vi.spyOn(objectLinks, "findActiveXeroObjectLinks").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        const rows = await original(...args);
        reached();
        await gate;
        return rows;
      });
      try {
        return await reconcile(kind, note);
      } finally {
        spy.mockRestore();
      }
    }

    /** The account-credit link write the inbound reconcile sends for a reading, held open on its own connection until `release()`. */
    async function holdReading(kind: Kind, status: string, updatedAt: string) {
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      const { xeroCreditNoteSnapshotMetadata } = await import("@/lib/xero-refund-note-status");
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let written!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (written = resolve));
      const committed = prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          await upsertXeroObjectLink(
            {
              localModel: "Payment", localId: PAYMENT[kind], xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE[kind], xeroObjectNumber: `CN-4347-${kind}`,
              role: "ACCOUNT_CREDIT_NOTE", metadata: xeroCreditNoteSnapshotMetadata(reading(kind, status, updatedAt)), mergeMetadata: true,
            },
            { store: tx },
          );
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
          written(pid);
          await released;
        },
        { timeout: 30_000 },
      );
      const pid = await Promise.race([holderPid, committed.then(() => { throw new Error("Held write ended before reporting its lock"); })]);
      return { pid, release, committed };
    }

    /**
     * Poll until a backend waits on a lock `blockerPid` holds - one running the
     * statement `waiterQuery` (a LIKE pattern) when given - so a schedule never
     * accepts the wrong waiter.
     */
    async function waitForBlockedBy(blockerPid: number, waiterQuery?: string) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < 10_000) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
            AND (${waiterQuery ?? null}::text IS NULL OR query LIKE ${waiterQuery ?? null}::text)
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const waiting = await prisma.$queryRaw<Array<{ pid: number; query: string }>>`
        SELECT pid, query FROM pg_stat_activity
        WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))`;
      throw new Error(`Timed out waiting for ${waiterQuery ?? "a write"} to queue behind pid ${blockerPid}; waiting: ${JSON.stringify(waiting)}`);
    }

    async function state(kind: Kind) {
      const link = await prisma.xeroObjectLink.findFirstOrThrow({
        where: { localId: PAYMENT[kind], xeroObjectId: NOTE[kind], role: "ACCOUNT_CREDIT_NOTE" },
        select: { active: true, metadata: true },
      });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT[kind] }, select: { refundedAmountCents: true } });
      const metadata = link.metadata as Record<string, unknown>;
      return { active: link.active, status: metadata.status, providerUpdatedAt: metadata.providerUpdatedAt, refundedAmountCents: payment.refundedAmountCents };
    }
    /** The void kept: VOIDED at its own timestamp, `active` as stored (#4347 keeps it), nothing refunded. */
    const VOID_KEPT = { active: true, status: "VOIDED", providerUpdatedAt: LATE, refundedAmountCents: 0 };
    /** The card control: the void is kept on the link, and the card ledger is never moved by Xero here. */
    const CARD_VOID_KEPT = { ...VOID_KEPT, refundedAmountCents: 0 };

    it("void, then an older AUTHORISED reading: the void and the $0 refunded total stand (sequential)", async () => {
      await seed();
      await reconcile("bank", reading("bank", "VOIDED", LATE));
      expect(await state("bank")).toEqual(VOID_KEPT);
      await reconcile("bank", reading("bank", "AUTHORISED", EARLY));
      // Before #4347: AUTHORISED written over VOIDED and $100 counted back.
      expect(await state("bank")).toEqual(VOID_KEPT);
    });

    it("an older AUTHORISED reading taken before the void and written after it keeps the void (schedule A)", async () => {
      await seed();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atGate = new Promise<void>((resolve) => (reached = resolve));
      const stale = pausedReconcile("bank", reading("bank", "AUTHORISED", EARLY), gate, reached);
      void stale.catch(() => undefined);
      try {
        await Promise.race([atGate, stale.then(() => { throw new Error("The stale reconcile finished before its gate"); })]);
        // The void's whole reconcile runs while the older reading is held.
        await reconcile("bank", reading("bank", "VOIDED", LATE));
        expect(await state("bank")).toEqual(VOID_KEPT);
      } finally {
        release();
      }
      await stale;
      expect(await state("bank")).toEqual(VOID_KEPT);
    });

    it("void then older AUTHORISED (lock-queued): the older reconcile waits on the void's account-credit row and keeps the void", async () => {
      await seed();
      const held = await holdReading("bank", "VOIDED", LATE);
      const stale = reconcile("bank", reading("bank", "AUTHORISED", EARLY));
      void stale.catch(() => undefined);
      try {
        await waitForBlockedBy(held.pid);
      } finally {
        held.release();
      }
      await held.committed;
      await stale;
      // The held write recorded the void but ran no recount: the stale reconcile's
      // recount counts N from its row as stored now, so the total falls to $0.
      expect(await state("bank")).toEqual(VOID_KEPT);
    });

    it("older AUTHORISED then void (lock-queued): the void's reconcile waits on the older write's row and wins", async () => {
      await seed();
      const held = await holdReading("bank", "AUTHORISED", EARLY);
      const voiding = reconcile("bank", reading("bank", "VOIDED", LATE));
      void voiding.catch(() => undefined);
      try {
        await waitForBlockedBy(held.pid);
      } finally {
        held.release();
      }
      await held.committed;
      await voiding;
      expect(await state("bank")).toEqual(VOID_KEPT);
      // And a later replay of the older reading still changes nothing.
      await reconcile("bank", reading("bank", "AUTHORISED", EARLY));
      expect(await state("bank")).toEqual(VOID_KEPT);
    });

    it("MUTATION (order): between two live readings the older one keeps the newer stored snapshot", async () => {
      await seed();
      await reconcile("bank", reading("bank", "PAID", LATE));
      await reconcile("bank", reading("bank", "AUTHORISED", EARLY));
      expect(await state("bank")).toEqual({ active: true, status: "PAID", providerUpdatedAt: LATE, refundedAmountCents: 10_000 });
    });

    it("a newer live reading after an older live one still applies", async () => {
      await seed();
      await reconcile("bank", reading("bank", "AUTHORISED", EARLY));
      await reconcile("bank", reading("bank", "PAID", LATE));
      expect(await state("bank")).toEqual({ active: true, status: "PAID", providerUpdatedAt: LATE, refundedAmountCents: 10_000 });
    });

    it("card control: both orders keep the void on the link and leave the card ledger where it was", async () => {
      await seed();
      await reconcile("card", reading("card", "VOIDED", LATE));
      await reconcile("card", reading("card", "AUTHORISED", EARLY));
      expect(await state("card")).toEqual(CARD_VOID_KEPT);
      await seed();
      const held = await holdReading("card", "AUTHORISED", EARLY);
      const voiding = reconcile("card", reading("card", "VOIDED", LATE));
      void voiding.catch(() => undefined);
      try {
        await waitForBlockedBy(held.pid);
      } finally {
        held.release();
      }
      await held.committed;
      await voiding;
      expect(await state("card")).toEqual(CARD_VOID_KEPT);
    });

    /** The member's BOOKING_APPLIED ledger rows for their live booking, and that payment's applied credit. */
    async function appliedCredit() {
      const rows = await prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID, appliedToBookingId: LIVE_BOOKING }, select: { amountCents: true } });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: LIVE_PAYMENT }, select: { creditAppliedCents: true } });
      return { rows: rows.map((row) => row.amountCents), creditAppliedCents: payment.creditAppliedCents };
    }
    const ALLOCATED_TO_LIVE = [{ invoice: { invoiceID: LIVE_INVOICE }, amount: 100, date: "2026-06-30" }];

    it("MUTATION (allocation repair): an older reading's allocation posts nothing to the member's ledger after the void", async () => {
      await seed();
      await reconcile("bank", reading("bank", "VOIDED", LATE));
      await reconcile("bank", reading("bank", "AUTHORISED", EARLY, ALLOCATED_TO_LIVE));
      // Before #4347 the stale reading spent $100 of the voided note on the live booking.
      expect(await appliedCredit()).toEqual({ rows: [], creditAppliedCents: 0 });
      expect(await state("bank")).toEqual(VOID_KEPT);
    });

    it("a current reading's allocation is still posted to the member's ledger", async () => {
      await seed();
      await reconcile("bank", reading("bank", "AUTHORISED", EARLY, ALLOCATED_TO_LIVE));
      expect(await appliedCredit()).toEqual({ rows: [-10_000], creditAppliedCents: 10_000 });
    });

    /**
     * `INV-LOCK-002`: a Payment-first writer holds the bank payment's row - the
     * lock #4200's explicit refund-note void and ALP-614's completion take
     * first - and then writes a refund-note link on that payment. An older
     * reconcile of the account-credit note runs meanwhile: its link write takes
     * only N's row and commits without waiting on the Payment, its recount then
     * queues on the Payment, and both finish.
     */
    it("lock order: the account-credit link write never waits on a held Payment row, and a Payment-first refund-note void completes beside it", async () => {
      await seed();
      await reconcile("bank", reading("bank", "VOIDED", LATE));
      const { lockPaymentForRefundedTotal, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } = await import("@/lib/payment-transactions");
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      const { xeroCreditNoteSnapshotMetadata } = await import("@/lib/xero-refund-note-status");
      const syncLinks = await import("@/lib/xero-sync");
      let mayWrite!: () => void;
      const gate = new Promise<void>((resolve) => (mayWrite = resolve));
      let locked!: (pid: number) => void;
      const paymentLocked = new Promise<number>((resolve) => (locked = resolve));
      const paymentFirst = prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await lockPaymentForRefundedTotal(tx, BT);
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
        locked(pid);
        await gate;
        // #4200: an explicit void of the payment's own refund note, Payment then its own link row.
        return upsertXeroObjectLink(
          {
            localModel: "Payment", localId: BT, xeroObjectType: "CREDIT_NOTE", xeroObjectId: REFUND_NOTE, xeroObjectNumber: "CN-4347-R",
            role: "REFUND_CREDIT_NOTE", metadata: xeroCreditNoteSnapshotMetadata({ status: "VOIDED", total: 50, updatedDateUTC: new Date(LATE) }), mergeMetadata: true,
          },
          { store: tx },
        );
      }, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS);
      void paymentFirst.catch(() => undefined);
      // The backstop lets the Payment-first writer go, so a cycle fails rather than hangs.
      const backstop = setTimeout(mayWrite, 15_000);
      // Record when the stale reconcile's account-credit link write commits.
      const original = syncLinks.upsertXeroObjectLink;
      let linkWrittenAfterMs: number | null = null;
      const startedAt = process.hrtime.bigint();
      const spy = vi.spyOn(syncLinks, "upsertXeroObjectLink").mockImplementation(async (...args: Parameters<typeof original>) => {
        const written = await original(...args);
        if (args[0].role === "ACCOUNT_CREDIT_NOTE" && linkWrittenAfterMs === null) linkWrittenAfterMs = realElapsedMs(startedAt);
        return written;
      });
      try {
        const pid = await Promise.race([paymentLocked, paymentFirst.then(() => { throw new Error("The Payment-first writer ended before reporting its lock"); })]);
        const stale = reconcile("bank", reading("bank", "AUTHORISED", EARLY));
        void stale.catch(() => undefined);
        // The recount, not the link write, is what waits on the held Payment row.
        await waitForBlockedBy(pid, '%SELECT 1 FROM "Payment"%FOR NO KEY UPDATE%');
        expect(linkWrittenAfterMs).not.toBeNull();
        expect(linkWrittenAfterMs!).toBeLessThan(5_000);
        mayWrite();
        await expect(paymentFirst).resolves.toBeDefined();
        await stale;
      } finally {
        clearTimeout(backstop);
        mayWrite();
        spy.mockRestore();
      }
      expect(await state("bank")).toEqual(VOID_KEPT);
      const refundLink = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: BT, xeroObjectId: REFUND_NOTE }, select: { active: true, metadata: true } });
      expect(refundLink).toMatchObject({ active: false, metadata: expect.objectContaining({ status: "VOIDED" }) });
    });
  },
);
